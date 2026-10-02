import { RequestHeaders, SUGGESTION_NOTICE } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';
import { BrokerService } from '../broker/broker.service';
import { EventNoticeSender, type Person } from '../outbox/event-notice';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';

const TAKE_PATH = '/api/internal/ai/actions/due/take';
const CLAIM_PATH = '/api/internal/notifications/suggestion/claim';
const HOLD_PATH = '/api/internal/notifications/retention/hold';
const NAMES_PATH = '/api/internal/billing/entitlement/grants/names';
const actionPath = (id: string, step: 'floor' | 'sent' | 'stop') => `/api/internal/ai/actions/${id}/${step}`;

/** Suggestions one run delivers; the rest wait five minutes. */
const TAKE_LIMIT = 100;
const CONSUMER = 'ai-suggestion';
const DAY_MS = 86_400_000;

/** The auth-service template each action type is told by; a type missing here is never told. */
export const SUGGESTION_TEMPLATE_OF: Record<string, string> = {
  renew: 'suggestionRenew',
  resize_up: 'suggestionResizeUp',
  resize_down: 'suggestionResizeDown',
};

type Due = {
  actionId: string;
  tenantId: string;
  subjectKind: string;
  subjectId: string;
  actionType: string;
  grantId: string | null;
  variantId: string | null;
  deadline: string | null;
};
type Claim = { deliver: 'now' | 'muted' } | { deliver: 'held'; botAt: string } | { deliver: 'later'; reason: string; retryAt: string };
type Names = {
  items: Array<{ grantId: string; label: string | null; nameKey: string | null; sku: string | null }>;
  plans: Array<{ variantId: string; nameKey: string; sku: string; size: string | null; price: { amount: string; currencyCode: string } }>;
};

/**
 * Delivers the AI engine's scheduled suggestions (F-038-g3, ADR-0109 points
 * 10, 11; user 2026-10-02: the worker runs the loop). The worker owns *when*
 * (ADR-0027); ai-service owns the action and the safety floor (F-038-g2);
 * notification owns mute, quiet hours and the 24 h after a retention notice
 * (F-038-g1); billing owns names and prices. Per suggestion, in this order:
 *
 * 1. **claim** — `muted` stops it, `later` moves it; nothing is told.
 * 2. **names and the plan's current offer** from billing: a plan no longer
 *    for sale stops it (`plan_unavailable`) *before* the floor, so no budget
 *    is spent on a pitch that will not go; the price told is today's.
 * 3. **floor** — the last check; a refusal was already handled by ai-service.
 * 4. **tell** — inbox and bot on their own (never joined to a burst: a
 *    suggestion is never a "count" summary); inside quiet hours the inbox
 *    now and the bot kept on the ledger for the window end, as a retention
 *    notice is.
 * 5. **sent**.
 *
 * Every five minutes. Safe to run twice: a take leases its actions, the claim
 * is one ledger row per action, and each channel is marked once per action id
 * by the sender. One suggestion failing is counted, never stops the others.
 */
@Injectable()
export class AiSuggestionDeliveryJob implements Job {
  readonly key = 'ai_suggestion_delivery';
  readonly name = 'AI suggestions';
  readonly description = "Tells users the AI engine's suggestions when they are due — in the inbox and on the bot, labelled (F-038-g).";
  readonly category = BotWorkerCategory.other;
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '*/5 * * * *' };

  private readonly logger = new Logger(AiSuggestionDeliveryJob.name);
  private sender: Pick<EventNoticeSender, 'send'>;
  private readonly ai: string;
  private readonly notification: string;
  private readonly billing: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(redis: RedisService, realtime: RealtimePublisher, config: ConfigService, broker: BrokerService) {
    this.sender = new EventNoticeSender(redis, realtime, config, broker);
    const base = (key: string) => config.get<string>(key, '').replace(/\/+$/, '');
    this.ai = base('AI_API_BASE_URL');
    this.notification = base('NOTIFICATION_API_BASE_URL');
    this.billing = base('BILLING_API_BASE_URL');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AI_API_TIMEOUT_MS', 60_000);
  }

  async run(now: Date = new Date()): Promise<JobResult> {
    for (const [name, value] of [['AI_API_BASE_URL', this.ai], ['NOTIFICATION_API_BASE_URL', this.notification], ['BILLING_API_BASE_URL', this.billing], ['SERVICE_AUTH_TOKEN', this.serviceToken]]) {
      if (!value) throw new Error(`${name} is not set`);
    }
    const taken = await this.post(this.ai, TAKE_PATH, { limit: TAKE_LIMIT });
    if (!Array.isArray(taken?.items)) throw new Error(`ai-service answered ${TAKE_PATH} without its items`);

    const counts = { taken: taken.items.length, sent: 0, held: 0, stopped: 0, refused: 0 };
    let errors = 0;
    for (const due of taken.items as Due[]) {
      try {
        const outcome = await this.deliver(due, now);
        counts[outcome] += 1;
      } catch (err) {
        errors += 1;
        this.logger.warn(`suggestion ${due.actionId} not delivered: ${(err as Error).message}`);
      }
    }
    if (counts.taken > 0) this.logger.log(`suggestions: ${counts.sent} sent, ${counts.held} held for quiet hours, ${counts.stopped} stopped, ${counts.refused} refused by the floor`);
    return { itemsProcessed: counts.sent + counts.held, errorsCount: errors, metrics: counts };
  }

  private async deliver(due: Due, now: Date): Promise<'sent' | 'held' | 'stopped' | 'refused'> {
    const template = SUGGESTION_TEMPLATE_OF[due.actionType];
    if (due.subjectKind !== 'user' || !due.grantId || !due.variantId || !template) {
      throw new Error(`a ${due.subjectKind} ${due.actionType} suggestion without a Grant and a plan cannot be told yet`);
    }
    const { tenantId, actionId, grantId } = due;
    const userId = due.subjectId;

    const claim = (await this.post(this.notification, CLAIM_PATH, { actionId, userId, grantId })) as Claim | null;
    if (!claim || !('deliver' in claim)) throw new Error(`notification answered ${CLAIM_PATH} without 'deliver'`);
    if (claim.deliver === 'muted' || claim.deliver === 'later') {
      const retry = claim.deliver === 'later' ? { retryAt: claim.retryAt } : {};
      await this.post(this.ai, actionPath(actionId, 'stop'), { tenantId, by: claim.deliver === 'muted' ? 'muted' : 'after_retention', ...retry });
      return 'stopped';
    }

    const names = (await this.post(this.billing, NAMES_PATH, { tenantId, userId, grantIds: [grantId], variantIds: [due.variantId] })) as Names | null;
    const plan = names?.plans?.find((p) => p.variantId === due.variantId);
    if (!plan) {
      await this.post(this.ai, actionPath(actionId, 'stop'), { tenantId, by: 'plan_unavailable' });
      return 'stopped';
    }

    const floor = await this.post(this.ai, actionPath(actionId, 'floor'), { tenantId });
    if (floor?.['pass'] !== true) return 'refused';

    const service = names?.items?.find((g) => g.grantId === grantId);
    const params: Record<string, string> = {
      // F-038-g4: the bot's "don't show this again" button names this action, never the user.
      actionId,
      ...(service?.label ? { serviceLabel: service.label } : {}),
      ...(service?.nameKey ? { serviceNameKey: service.nameKey } : {}),
      ...(service?.sku ? { serviceSku: service.sku } : {}),
      planNameKey: plan.nameKey,
      planSku: plan.sku,
      ...(plan.size ? { planSize: plan.size } : {}),
      price: `${plan.price.amount} ${plan.price.currencyCode}`,
      ...(due.deadline ? { days: String(Math.max(1, Math.ceil((new Date(due.deadline).getTime() - now.getTime()) / DAY_MS))) } : {}),
    };
    const person: Person = { tenantId, userId, grantId, template, params };

    if (claim.deliver === 'held') {
      await this.sender.send({ consumer: CONSUMER, eventId: actionId, person, only: ['inbox'], class: 'suggestion' });
      await this.post(this.notification, HOLD_PATH, { eventId: actionId, grantId, notice: SUGGESTION_NOTICE, period: actionId, tenantId, template, params, botAt: claim.botAt });
    } else {
      await this.sender.send({ consumer: CONSUMER, eventId: actionId, person, only: ['inbox', 'bot'], class: 'suggestion' });
    }
    await this.post(this.ai, actionPath(actionId, 'sent'), { tenantId });
    return claim.deliver === 'held' ? 'held' : 'sent';
  }

  private async post(base: string, path: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${base} answered ${response.status} to ${path}`);
      return envelopeData(await response.json());
    } finally {
      clearTimeout(timer);
    }
  }
}
