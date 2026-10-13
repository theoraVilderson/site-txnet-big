import { remainingLabel, serviceCallHeaders, SUGGESTION_NOTICE } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory, Prisma } from '@prisma/client';
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
const COUPON_PATH = '/api/internal/billing/coupons/ai-offer';
const OTHER_GATEWAY_PATH = '/api/internal/billing/deposit/other-gateway';
const WHEEL_CHECK_PATH = '/api/internal/billing/engagement/wheel/invite-check';
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
  top_up_wallet: 'suggestionTopUpWallet',
  win_back: 'suggestionWinBack',
  retain_offer: 'suggestionRetainOffer',
  checkout_help: 'suggestionCheckoutHelp',
  usage_alert: 'suggestionUsageAlert',
  wheel_invite: 'suggestionWheelInvite',
};

/** A reseller's upgrade (F-038-o4): `resize_up` about a package, told to the reseller's owner. */
export const PACKAGE_UPGRADE_TEMPLATE = 'suggestionPackageUpgrade';
/** A reseller's billing-wallet top-up (F-1525-c), told to its owner. */
export const RESELLER_TOP_UP_TEMPLATE = 'suggestionResellerTopUp';

type Due = {
  actionId: string;
  tenantId: string;
  subjectKind: string;
  subjectId: string;
  actionType: string;
  grantId: string | null;
  variantId: string | null;
  /** `top_up_wallet` only (F-038-k): the amount to top up, C-02. */
  amount?: { amount: string; currencyCode: string } | null;
  /** `retain_offer` only (F-038-f3): the offer billing issues the personal coupon from. */
  offer?: {
    offerId: string;
    couponTemplateId?: string | null;
    maxDiscountPercent?: string;
    dailyBudget?: string;
    budgetCurrencyCode?: string;
    createdByUserId?: string;
  } | null;
  /** `checkout_help` only (F-038-m): the unfinished payment it is about. */
  payment?: { paymentId: string; amount: Money } | null;
  /** `usage_alert` only (F-1516): the last 24 h against the usual day, bytes as decimal strings. */
  usage?: { meterKey: string; lastDayBytes: string; usualDayBytes: string; factor: number } | null;
  /** F-038-o4 / F-1525-c: a reseller's suggestion — read by ai at the take, never at the decision. */
  reseller?: {
    recipientUserId: string;
    currentPackageId: string | null;
    fromPackageId: string | null;
    /** The upgrade's; null for a top-up. */
    packageId: string | null;
    packageName: string | null;
    packageActive: boolean;
    price: Money | null;
    meter: string | null;
    period: string | null;
    included: number | null;
    used: number | null;
    newIncluded: number | null;
    productNameKey: string | null;
    /** The top-up's: the billing wallet when it was decided, and now (decimal strings). */
    balanceThen?: string | null;
    balanceNow?: string | null;
  } | null;
  deadline: string | null;
};
type Money = { amount: string; currencyCode: string };
type OtherGateway = { paid: true } | { gateway: { displayName: string; category: string } | null };
type WheelCheck = { wheel: false } | { wheel: true; eligible: boolean; refusalReason: string | null; spinsLeftToday: number };
/** What a suggestion says, or the step that stops it before the floor. */
type Words = { params: Record<string, string> } | { stop: string; retryAt?: string };
type Coupon =
  | { issued: { code: string; discount: Money; priceAfter: Money; expiresAt: string } }
  | { refused: 'plan_unavailable' | 'offer_unavailable' | 'budget_spent'; retryAt?: string };
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
 *    is spent on a pitch that will not go; the price told is today's. A
 *    `retain_offer` then gets its personal coupon from billing (F-038-f3): an
 *    offer that no longer applies stops it, a day's budget spent moves it to
 *    the next day. A `checkout_help` (F-038-m) is about no service: claimed
 *    with no Grant (F-038-g5), it asks billing for another gateway instead —
 *    none, or paid since, stops it. A `usage_alert` (F-1516) names its
 *    service only: it sells no plan, so none has to be for sale. A
 *    `wheel_invite` (F-038-u) is about no service either: billing says
 *    whether the user may still spin — no wheel, or not now, stops it.
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
    // F-038-o4: a reseller as the platform's customer, told to its owner — a user of the platform's own tenant.
    if (due.subjectKind === 'tenant') {
      const reseller = due.reseller;
      if (reseller && due.actionType === 'resize_up' && reseller.packageId && reseller.meter) {
        return this.tell(due, { userId: reseller.recipientUserId, template: PACKAGE_UPGRADE_TEMPLATE }, async () => upgradeWords(reseller));
      }
      // F-1525-c: a top-up names its amount, or it is not told.
      if (reseller && due.actionType === 'top_up_wallet' && due.amount) {
        const amount = due.amount;
        return this.tell(due, { userId: reseller.recipientUserId, template: RESELLER_TOP_UP_TEMPLATE }, async () => resellerTopUpWords(reseller, amount, due.deadline, now));
      }
      throw new Error(`a reseller's ${due.actionType} suggestion without its reseller, package or amount cannot be told`);
    }
    const template = SUGGESTION_TEMPLATE_OF[due.actionType];
    // F-038-m: `checkout_help` is about a payment, not a service — the one type told with no Grant (F-038-g5).
    const aboutPayment = due.actionType === 'checkout_help';
    // F-1516: a usage alert is about a service and names no plan.
    const aboutUsage = due.actionType === 'usage_alert';
    // F-038-u: an invite to the wheel is about no service, claimed with no Grant (F-038-g5).
    const aboutWheel = due.actionType === 'wheel_invite';
    if (due.subjectKind !== 'user' || !template || (!aboutPayment && !aboutWheel && (!due.grantId || (!aboutUsage && !due.variantId)))) {
      throw new Error(`a ${due.subjectKind} ${due.actionType} suggestion without a Grant and a plan cannot be told yet`);
    }
    if (aboutPayment && !due.payment) throw new Error(`checkout_help suggestion ${due.actionId} carries no payment`);
    if (aboutUsage && !due.usage) throw new Error(`usage_alert suggestion ${due.actionId} carries no usage`);
    // F-038-k: a top-up names its amount, or it is not told — "top up {{amount}}" with a blank is no message.
    if (due.actionType === 'top_up_wallet' && !due.amount) throw new Error(`top_up_wallet suggestion ${due.actionId} carries no amount`);
    // F-038-f3: a discount is told only with the coupon that gives it, issued from its offer's terms.
    const offer = due.offer;
    if (due.actionType === 'retain_offer' && (!offer?.dailyBudget || !offer.maxDiscountPercent || !offer.budgetCurrencyCode || !offer.createdByUserId || !due.deadline)) {
      throw new Error(`retain_offer suggestion ${due.actionId} carries no offer terms or deadline`);
    }
    return this.tell(due, { userId: due.subjectId, grantId: due.grantId ?? undefined, template }, () =>
      aboutPayment ? this.helpWords(due) : aboutUsage ? this.usageWords(due) : aboutWheel ? this.wheelWords(due) : this.serviceWords(due, now),
    );
  }

  /**
   * The steps every suggestion goes through once its recipient and template
   * are known: claim, its words (or the step that stops it), the floor, the
   * channels, sent.
   */
  private async tell(due: Due, to: { userId: string; grantId?: string; template: string }, wordsOf: () => Promise<Words>): Promise<'sent' | 'held' | 'stopped' | 'refused'> {
    const { tenantId, actionId } = due;
    const { userId, grantId, template } = to;
    const aGrant = grantId ? { grantId } : {};

    const claim = (await this.post(this.notification, CLAIM_PATH, { actionId, userId, ...aGrant })) as Claim | null;
    if (!claim || !('deliver' in claim)) throw new Error(`notification answered ${CLAIM_PATH} without 'deliver'`);
    if (claim.deliver === 'muted' || claim.deliver === 'later') {
      const retry = claim.deliver === 'later' ? { retryAt: claim.retryAt } : {};
      await this.post(this.ai, actionPath(actionId, 'stop'), { tenantId, by: claim.deliver === 'muted' ? 'muted' : 'after_retention', ...retry });
      return 'stopped';
    }

    // What the message says, from billing — or why it is not told; all before the floor, which charges the budget.
    const words = await wordsOf();
    if ('stop' in words) {
      await this.post(this.ai, actionPath(actionId, 'stop'), { tenantId, by: words.stop, ...(words.retryAt ? { retryAt: words.retryAt } : {}) });
      return 'stopped';
    }

    const floor = await this.post(this.ai, actionPath(actionId, 'floor'), { tenantId });
    if (floor?.['pass'] !== true) return 'refused';

    // F-038-g4: the bot's "don't show this again" button names this action, never the user.
    const params: Record<string, string> = { actionId, ...words.params };
    const person: Person = { tenantId, userId, ...aGrant, template, params };

    if (claim.deliver === 'held') {
      await this.sender.send({ consumer: CONSUMER, eventId: actionId, person, only: ['inbox'], class: 'suggestion' });
      await this.post(this.notification, HOLD_PATH, { eventId: actionId, ...aGrant, notice: SUGGESTION_NOTICE, period: actionId, tenantId, template, params, botAt: claim.botAt });
    } else {
      await this.sender.send({ consumer: CONSUMER, eventId: actionId, person, only: ['inbox', 'bot'], class: 'suggestion' });
    }
    await this.post(this.ai, actionPath(actionId, 'sent'), { tenantId });
    return claim.deliver === 'held' ? 'held' : 'sent';
  }

  /** A suggestion about a service: its name and the plan's offer now, and a `retain_offer`'s coupon (F-038-f3). */
  private async serviceWords(due: Due, now: Date): Promise<Words> {
    const { tenantId, actionId } = due;
    const userId = due.subjectId;
    const grantId = due.grantId as string;
    const names = (await this.post(this.billing, NAMES_PATH, { tenantId, userId, grantIds: [grantId], variantIds: [due.variantId] })) as Names | null;
    const plan = names?.plans?.find((p) => p.variantId === due.variantId);
    if (!plan) return { stop: 'plan_unavailable' };

    // F-038-f3: billing issues the personal coupon — and spends the offer's budget — before the floor, so a
    // spent budget or an offer gone costs the user's attention nothing; a retry gets the same coupon.
    let coupon: Extract<Coupon, { issued: unknown }>['issued'] | null = null;
    const offer = due.offer;
    if (due.actionType === 'retain_offer' && offer) {
      const answer = (await this.post(this.billing, COUPON_PATH, {
        tenantId,
        userId,
        actionId,
        offerId: offer.offerId,
        createdByUserId: offer.createdByUserId,
        variantId: due.variantId,
        couponTemplateId: offer.couponTemplateId ?? null,
        maxDiscountPercent: offer.maxDiscountPercent,
        dailyBudget: offer.dailyBudget,
        currencyCode: offer.budgetCurrencyCode,
        expiresAt: due.deadline,
      })) as Coupon | null;
      if (!answer || !('issued' in answer || 'refused' in answer)) throw new Error(`billing answered ${COUPON_PATH} without 'issued' or 'refused'`);
      if ('refused' in answer) return { stop: answer.refused === 'budget_spent' ? 'offer_budget' : answer.refused, retryAt: answer.retryAt };
      coupon = answer.issued;
    }

    const service = names?.items?.find((g) => g.grantId === grantId);
    return {
      params: {
        ...(service?.label ? { serviceLabel: service.label } : {}),
        ...(service?.nameKey ? { serviceNameKey: service.nameKey } : {}),
        ...(service?.sku ? { serviceSku: service.sku } : {}),
        planNameKey: plan.nameKey,
        planSku: plan.sku,
        ...(plan.size ? { planSize: plan.size } : {}),
        // A discounted renewal is told at the price after its coupon, and the coupon itself.
        price: coupon ? `${coupon.priceAfter.amount} ${coupon.priceAfter.currencyCode}` : `${plan.price.amount} ${plan.price.currencyCode}`,
        ...(coupon ? { code: coupon.code, discount: `${coupon.discount.amount} ${coupon.discount.currencyCode}` } : {}),
        ...(due.amount ? { amount: `${due.amount.amount} ${due.amount.currencyCode}` } : {}),
        ...(due.deadline ? { days: String(Math.max(1, Math.ceil((new Date(due.deadline).getTime() - now.getTime()) / DAY_MS))) } : {}),
      },
    };
  }

  /** F-1516: `usage_alert` — the service's name, what its last 24 h used, its usual day and how many times that is. */
  private async usageWords(due: Due): Promise<Words> {
    const usage = due.usage as NonNullable<Due['usage']>;
    const grantId = due.grantId as string;
    const names = (await this.post(this.billing, NAMES_PATH, { tenantId: due.tenantId, userId: due.subjectId, grantIds: [grantId] })) as Names | null;
    const service = names?.items?.find((g) => g.grantId === grantId);
    return {
      params: {
        ...(service?.label ? { serviceLabel: service.label } : {}),
        ...(service?.nameKey ? { serviceNameKey: service.nameKey } : {}),
        ...(service?.sku ? { serviceSku: service.sku } : {}),
        used: remainingLabel(BigInt(usage.lastDayBytes)),
        usual: remainingLabel(BigInt(usage.usualDayBytes)),
        times: String(Math.floor(usage.factor)),
      },
    };
  }

  /** F-038-m: `checkout_help` — another gateway the user can pay with, named by billing; none, or paid since, is not told. */
  private async helpWords(due: Due): Promise<Words> {
    const payment = due.payment as NonNullable<Due['payment']>;
    const answer = (await this.post(this.billing, OTHER_GATEWAY_PATH, { tenantId: due.tenantId, userId: due.subjectId, paymentId: payment.paymentId })) as OtherGateway | null;
    if (!answer || !('paid' in answer || 'gateway' in answer)) throw new Error(`billing answered ${OTHER_GATEWAY_PATH} without 'paid' or 'gateway'`);
    if ('paid' in answer) return { stop: 'already_paid' };
    if (!answer.gateway) return { stop: 'no_other_gateway' };
    return { params: { gateway: answer.gateway.displayName, amount: `${payment.amount.amount} ${payment.amount.currencyCode}` } };
  }

  /** F-038-u: `wheel_invite` — told only while billing says the user may spin; the wheel's odds are its own. */
  private async wheelWords(due: Due): Promise<Words> {
    const answer = (await this.post(this.billing, WHEEL_CHECK_PATH, { tenantId: due.tenantId, userId: due.subjectId })) as WheelCheck | null;
    if (!answer || !('wheel' in answer)) throw new Error(`billing answered ${WHEEL_CHECK_PATH} without 'wheel'`);
    if (!answer.wheel) return { stop: 'no_wheel' };
    if (!answer.eligible) return { stop: 'not_eligible' };
    return { params: {} };
  }

  private async post(base: string, path: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...serviceCallHeaders(this.serviceToken) },
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

/**
 * F-038-o4: the package as ai read it at the take. A reseller already moved
 * off the package the engine saw (it upgraded, or changed) is not told —
 * `already_paid`; a package no longer sold, or unpriced for its period, is
 * `plan_unavailable`. The quota is named by auth-service as a quota alert
 * names it: a registry key, or a product's catalog name.
 */
export function upgradeWords(r: NonNullable<Due['reseller']>): Words {
  if (r.currentPackageId !== r.fromPackageId) return { stop: 'already_paid' };
  if (!r.packageActive || !r.price || !r.packageName) return { stop: 'plan_unavailable' };
  return {
    params: {
      ...((r.meter ?? '').startsWith('product:') ? (r.productNameKey ? { productNameKey: r.productNameKey } : {}) : { quotaKey: r.meter ?? '' }),
      package: r.packageName,
      price: `${r.price.amount} ${r.price.currencyCode}`,
      used: String(r.used ?? 0),
      included: String(r.included ?? 0),
      newIncluded: r.newIncluded === null ? 'unlimited' : String(r.newIncluded),
    },
  };
}

/**
 * F-1525-c: a billing-wallet top-up — the amount and the days to the run-out.
 * A wallet that grew since the decision was topped up (or credited): the
 * suggestion is moot — `already_paid`, before the floor (C-02: compared as
 * Decimal).
 */
export function resellerTopUpWords(r: NonNullable<Due['reseller']>, amount: Money, deadline: string | null, now: Date): Words {
  if (r.balanceThen && r.balanceNow && new Prisma.Decimal(r.balanceNow).gt(r.balanceThen)) return { stop: 'already_paid' };
  return {
    params: {
      amount: `${amount.amount} ${amount.currencyCode}`,
      ...(deadline ? { days: String(Math.max(1, Math.ceil((new Date(deadline).getTime() - now.getTime()) / DAY_MS))) } : {}),
    },
  };
}
