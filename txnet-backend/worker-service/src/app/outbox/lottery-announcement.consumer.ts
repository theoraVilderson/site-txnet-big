import { createHash } from 'node:crypto';

import { OutboxEventType, type OutboxMessage, serviceCallHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { envelopeData } from '../automation/internal-answer';
import { BrokerService } from '../broker/broker.service';
import { RedisService } from '../redis/redis.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { EventNoticeSender, type Person } from './event-notice';

/** This consumer's segment of its per-channel markers (ADR-0045, F-067-o). */
const CONSUMER = 'lottery-announcement';
const PAGE = 500;
const audiencePath = (lotteryId: string) => `/api/internal/billing/engagement/lotteries/${lotteryId}/audience`;
const CLAIM_PATH = '/api/internal/notifications/lottery/claim';
const HOLD_PATH = '/api/internal/notifications/retention/hold';

type Claim = { deliver: 'now' | 'muted' } | { deliver: 'held'; botAt: string };
type PrizeServiceName = { label: string | null; sku: string | null; nameKey: string | null };
/** `prizeChoices`: members with a prize service to choose, and where a prize would go now; `null` = automatic (F-707-z). */
type AudiencePage = { open: boolean; tenantId: string | null; title: string | null; entryMode: string | null; userIds: string[]; prizeChoices?: Record<string, PrizeServiceName | null>; next: string | null };

/** The notice's prize-service params: the flag that draws the button, and the current service's name parts when one is chosen. */
function prizeParams(choice: PrizeServiceName | null): Record<string, string> {
  const parts = { serviceLabel: choice?.label ?? null, serviceSku: choice?.sku ?? null, serviceNameKey: choice?.nameKey ?? null };
  return { prizeChoice: '1', ...Object.fromEntries(Object.entries(parts).filter((e): e is [string, string] => e[1] !== null)) };
}

/**
 * One id per lottery and member, the same on every delivery (a name-based
 * UUID, version 5 layout over SHA-1): the ledger row's `eventId` and the
 * sender's markers, so a fan-out run again never tells anyone twice.
 */
export function announcementEventId(lotteryId: string, userId: string): string {
  const h = createHash('sha1').update(`txnet-lottery-announcement:${lotteryId}:${userId}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * A new lottery told to its group (F-707-q, user 2026-10-03):
 * `engagement.lottery.published` -> billing's audience, a page of user members
 * at a time, each claimed on notification's ledger and told.
 *
 * - **opt-in**: the inbox and the bot, class `important` — the user must join
 *   before the close; the bot message carries the Join button
 *   (auth-service, `lotteryJoinCallback`). Quiet hours hold the bot on the
 *   ledger for the window's end (`RetentionHeldNoticeJob` tells it).
 * - **automatic**: the inbox alone (`lotteryOpenedAutomatic`, `info`) — it asks
 *   nothing of the user.
 * - The user's `lottery` mute skips them; a reseller member is never in the
 *   audience (it never enters).
 *
 * Every page is asked while the lottery is open, so a cancel or the close
 * stops the fan-out. One member failing is counted and the others told; the
 * event then throws and is delivered again, which the per-member id makes safe.
 * Its own queue: a group of thousands never holds up another notice.
 */
@Injectable()
export class LotteryAnnouncementConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(LotteryAnnouncementConsumer.name);
  private sender: Pick<EventNoticeSender, 'send'>;
  private readonly billing: string;
  private readonly notification: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly broker: BrokerService,
    redis: RedisService,
    realtime: RealtimePublisher,
    config: ConfigService,
  ) {
    this.sender = new EventNoticeSender(redis, realtime, config, broker);
    const base = (key: string) => config.get<string>(key, '').replace(/\/+$/, '');
    this.billing = base('BILLING_API_BASE_URL');
    this.notification = base('NOTIFICATION_API_BASE_URL');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('BILLING_API_TIMEOUT_MS', 30_000);
  }

  async onApplicationBootstrap() {
    await this.broker.consumeLotteryAnnouncements((event) => this.handle(event));
    this.logger.log('consuming engagement.lottery.published to tell each lottery’s group');
  }

  async handle(event: OutboxMessage): Promise<void> {
    if (event.type !== OutboxEventType.LOTTERY_PUBLISHED) return;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const lotteryId = typeof p.lotteryId === 'string' ? p.lotteryId : null;
    if (!lotteryId) throw new Error(`outbox event ${event.id} has a payload without its lottery`);
    if (!this.billing || !this.notification || !this.serviceToken) throw new Error('BILLING_API_BASE_URL, NOTIFICATION_API_BASE_URL and SERVICE_AUTH_TOKEN must be set');

    let after: string | null = null;
    let told = 0;
    let failed = 0;
    for (;;) {
      const page = await this.audience(lotteryId, after);
      if (!page.open || !page.tenantId) break;
      for (const userId of page.userIds) {
        try {
          if (await this.tell(page, lotteryId, userId)) told += 1;
        } catch (err) {
          failed += 1;
          this.logger.warn(`lottery ${lotteryId}: member ${userId} not told: ${(err as Error).message}`);
        }
      }
      if (!page.next) break;
      after = page.next;
    }
    if (told > 0) this.logger.log(`lottery ${lotteryId}: ${told} member(s) told`);
    if (failed > 0) throw new Error(`lottery ${lotteryId}: ${failed} of ${told + failed} member(s) not told`);
  }

  /** `false`: muted. */
  private async tell(page: AudiencePage, lotteryId: string, userId: string): Promise<boolean> {
    const eventId = announcementEventId(lotteryId, userId);
    const claim = (await this.call(this.notification, CLAIM_PATH, { eventId, lotteryId, userId })) as Claim | null;
    if (!claim || !('deliver' in claim)) throw new Error(`notification answered ${CLAIM_PATH} without 'deliver'`);
    if (claim.deliver === 'muted') return false;

    const tenantId = page.tenantId as string;
    const choice = page.prizeChoices?.[userId];
    const params = { title: page.title ?? '', lotteryId, ...(choice === undefined ? {} : prizeParams(choice)) };
    const automatic = page.entryMode !== 'opt_in';
    // An automatic lottery asks nothing — unless the member has a prize service to choose (F-707-z): then the bot too.
    if (automatic && choice === undefined) {
      const person: Person = { tenantId, userId, template: 'lotteryOpenedAutomatic', params };
      await this.sender.send({ consumer: CONSUMER, eventId, person, only: ['inbox'], class: 'info' });
      return true;
    }
    const person: Person = { tenantId, userId, template: automatic ? 'lotteryOpenedAutomatic' : 'lotteryOpened', params };
    if (claim.deliver === 'held') {
      await this.sender.send({ consumer: CONSUMER, eventId, person, only: ['inbox'], class: 'important' });
      await this.call(this.notification, HOLD_PATH, {
        eventId,
        notice: OutboxEventType.LOTTERY_PUBLISHED,
        period: `${lotteryId}:${userId}`,
        tenantId,
        template: person.template,
        params,
        botAt: claim.botAt,
      });
    } else {
      await this.sender.send({ consumer: CONSUMER, eventId, person, only: ['inbox', 'bot'], class: 'important' });
    }
    return true;
  }

  private async audience(lotteryId: string, after: string | null): Promise<AudiencePage> {
    const q = `?limit=${PAGE}${after ? `&after=${after}` : ''}`;
    const page = (await this.call(this.billing, `${audiencePath(lotteryId)}${q}`)) as AudiencePage | null;
    if (!page || !Array.isArray(page.userIds)) throw new Error(`billing answered the audience of lottery ${lotteryId} without its members`);
    return page;
  }

  /** GET without a payload, POST with one; both answer shared-core's envelope. */
  private async call(base: string, path: string, payload?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${base}${path}`, {
        method: payload ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', ...serviceCallHeaders(this.serviceToken) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${base} answered ${response.status} to ${path}`);
      return envelopeData(await response.json());
    } finally {
      clearTimeout(timer);
    }
  }
}
