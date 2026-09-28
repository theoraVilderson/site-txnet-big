import { randomUUID } from 'node:crypto';

import { IdentityHeaders, RedisTtl, RequestHeaders, UnscopedRedisKeys } from '@txnet-backend/shared-core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { envelopeData } from '../automation/internal-answer';
import type { BrokerService, NoticeFlush } from '../broker/broker.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';

export type { NoticeFlush } from '../broker/broker.service';

/** auth-service's seam for telling a user a named notice (ADR-0045 decision 2). */
const NOTIFY_PATH = '/api/internal/notify/user';

/** The seam's channels, in the order they are tried after the live push. */
const PERSON_CHANNELS = ['inbox', 'bot'] as const;
export type PersonChannel = (typeof PERSON_CHANNELS)[number];

/** The marker segment of a combined notice's channels; the flush id is the "event" (F-067-p). */
const BURST_CONSUMER = 'notice-burst';

/** billing's names of one user's Grants, for a combined notice to list (F-601-p). */
const NAMES_PATH = '/api/internal/billing/entitlement/grants/names';

/**
 * One service of a combined notice, as auth-service renders it in the user's
 * language (F-601-p): the buyer's own name for it (F-307-x), its catalog name
 * key (the sku when the language has no text), and the buyer's labels on its
 * live configs. `null`s: a Grant billing
 * did not name, told as "a service".
 */
export type ServiceName = { label: string | null; nameKey: string | null; sku: string | null; labels: string[] };

/**
 * Add one event to its burst and, if the burst had no flush yet, claim it.
 * KEYS: burst hash, scheduled flag. ARGV: event id, params json, hash ttl,
 * scheduled ttl, the flush id to claim with. Returns 1 when this call claimed.
 */
export const NOTICE_BURST_ADD = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if redis.call('SET', KEYS[2], ARGV[5], 'NX', 'EX', ARGV[4]) then return 1 end
return 0`;

/**
 * Take a burst into its flush's batch, once. KEYS: scheduled flag, burst hash,
 * batch. ARGV: batch ttl, flush id. A batch that already exists is a
 * redelivered flush: it is read again and nothing newer joins it. The flag is
 * cleared only if it is still this flush's, so a later burst keeps its own.
 */
export const NOTICE_BURST_TAKE = `
if redis.call('EXISTS', KEYS[3]) == 0 then
  if redis.call('GET', KEYS[1]) == ARGV[2] then redis.call('DEL', KEYS[1]) end
  if redis.call('EXISTS', KEYS[2]) == 1 then
    redis.call('RENAME', KEYS[2], KEYS[3])
    redis.call('EXPIRE', KEYS[3], ARGV[1])
  end
end
return redis.call('HGETALL', KEYS[3])`;

/** `grantId`: the service a retention notice is about, so a combined one can name it (F-601-p). */
export type Person = { tenantId: string; userId: string; template: string; params: Record<string, string>; grantId?: string };

/** One burst entry as stored: its params, and its Grant when it has one. */
type Entry = { params: Record<string, string>; grantId?: string };

/**
 * One event, told (F-067-o, ADR-0084 decision 2). `consumer` is the notice's
 * segment of its markers; `live` is the push to every open device;
 * `person` is the one user told in their inbox and on their bot — for a
 * tenant-audience event, the tenant's `ownerUserId`. The words are
 * auth-service's, in that user's language.
 *
 * `only` names the person's channels to tell, each on its own and never
 * joined to a burst: a retention notice in the user's quiet hours is told to
 * the inbox now and to the bot when they end (F-601-m). With `window: 'hour'`
 * and `only: ['inbox']` — a non-urgent notice held for quiet hours — the inbox
 * row joins an hour lane of its own whose flush tells the inbox alone, so the
 * same notice of several services is one row (F-601-q).
 */
export type EventNotice = {
  consumer: string;
  eventId: string;
  live?: { channel: `user:${string}` | `tenant:${string}`; body: Record<string, unknown> };
  person?: Person;
  only?: readonly PersonChannel[];
  /**
   * `hour`: a non-urgent retention notice (F-601-p) — its burst waits
   * `AUTOMATION_RETENTION_WINDOW_MS` for the same notice of the user's other
   * services, in a lane of its own. Absent: the 10 s burst.
   */
  window?: 'hour';
};

/**
 * The one sender every event notice goes through (F-067-o, ADR-0084
 * decision 2), in place of each consumer's own copy.
 *
 * **Each channel is its own once.** The marker
 * `outboxProcessed(<consumer>:<channel>, <event id>)` is `SET NX` before that
 * channel's side effect, and given back if it throws. The other channels still
 * run, then the sender rethrows, so the event dead-letters (F-067-d) with only
 * the failed channel owed: a redelivery never repeats a bot message or an
 * inbox row that already landed.
 *
 * **A burst is told once (F-067-p, decision 3).** The live push goes out at
 * once and is never combined. The inbox and bot notice joins its recipient's
 * burst for that template, and the first event of a burst schedules a flush
 * `AUTOMATION_NOTICE_WINDOW_MS` later through the broker's delay queue. The
 * flush tells the event itself if it was alone, or one summary with `count`.
 *
 * **Several services, named** (F-601-p). A retention notice carries its
 * Grant; a combined flush of them asks billing for the services' names once
 * and tells them beside `count`. A lookup that fails tells the summary alone:
 * a notice without its list beats one not told.
 */
export class EventNoticeSender {
  private readonly logger = new Logger(EventNoticeSender.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;
  private readonly windowMs: number;
  private readonly hourMs: number;
  private readonly billingUrl: string;
  private readonly billingTimeoutMs: number;

  constructor(
    private readonly redis: RedisService,
    private readonly realtime: RealtimePublisher,
    config: ConfigService,
    private readonly broker: Pick<BrokerService, 'publishNoticeFlush'>,
  ) {
    this.baseUrl = config.get<string>('AUTH_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 30_000);
    this.windowMs = config.get<number>('AUTOMATION_NOTICE_WINDOW_MS', 10_000);
    this.hourMs = config.get<number>('AUTOMATION_RETENTION_WINDOW_MS', 3_600_000);
    this.billingUrl = config.get<string>('BILLING_API_BASE_URL', '').replace(/\/+$/, '');
    this.billingTimeoutMs = config.get<number>('BILLING_API_TIMEOUT_MS', 30_000);
  }

  async send(notice: EventNotice): Promise<void> {
    const failures: unknown[] = [];
    const { live, person } = notice;
    if (live) await this.once(notice, 'live', () => this.realtime.publish(live.channel, live.body), failures);
    if (person && notice.window && notice.only?.length === 1 && notice.only[0] === 'inbox') {
      await this.once(notice, 'inbox', () => this.join(notice.eventId, person, notice.window, 'inbox'), failures);
    } else if (person && notice.only) {
      for (const channel of notice.only) await this.once(notice, channel, () => this.tell(channel, person), failures);
    } else if (person) {
      const owed = await this.owedBeforeBursts(notice);
      if (owed === null) await this.once(notice, 'person', () => this.join(notice.eventId, person, notice.window), failures);
      for (const channel of owed ?? []) await this.once(notice, channel, () => this.tell(channel, person), failures);
    }
    if (failures.length > 0) throw failures[0];
  }

  /**
   * An event F-067-o already told on a channel keeps its F-067-o markers: the
   * channels it still owes are told on their own, never joined to a burst,
   * so the F-067-p marker change repeats nothing (ADR-0084 consequences: a
   * rename is accepted once). `null` is every other event. Dead code once
   * those markers expire (`RedisTtl.outboxProcessed`, 7 days after deploy).
   */
  private async owedBeforeBursts(notice: EventNotice): Promise<PersonChannel[] | null> {
    const told = await this.redis.present(
      PERSON_CHANNELS.map((channel) => UnscopedRedisKeys.outboxProcessed(`${notice.consumer}:${channel}`, notice.eventId)),
    );
    if (!told.some(Boolean)) return null;
    return PERSON_CHANNELS.filter((_, i) => !told[i]);
  }

  /**
   * Tell one scheduled burst (F-067-p): the event itself if it was alone, one
   * summary with `count` otherwise. Each channel is marked under the flush id,
   * so a redelivered flush repeats only the channel that failed, over the
   * batch it first took.
   */
  async flush(flush: NoticeFlush): Promise<void> {
    const { flushId, tenantId, userId, template, window, only } = flush;
    const flat = await this.redis.evalScript<string[]>(
      NOTICE_BURST_TAKE,
      [
        UnscopedRedisKeys.noticeBurstScheduled(tenantId, userId, template, window, only),
        UnscopedRedisKeys.noticeBurst(tenantId, userId, template, window, only),
        UnscopedRedisKeys.noticeBurstBatch(flushId),
      ],
      [RedisTtl.outboxProcessed, flushId],
    );
    const entries = flat.filter((_, i) => i % 2 === 1).map(entryOf);
    const count = entries.length;
    if (count === 0) return;
    const person: Person = { tenantId, userId, template, params: count === 1 ? entries[0]!.params : {} };
    const services = count > 1 ? await this.names(tenantId, userId, entries) : undefined;
    const failures: unknown[] = [];
    const told = { consumer: BURST_CONSUMER, eventId: flushId };
    for (const channel of only ? [only] : PERSON_CHANNELS) {
      await this.once(told, channel, () => this.tell(channel, person, count > 1 ? count : undefined, services), failures);
    }
    if (failures.length > 0) throw failures[0];
  }

  /**
   * Tell several items of one template on one channel as one message
   * (F-601-p): the bot messages held for one user's quiet hours and due
   * together. Each item is marked on its own before the tell and given back
   * if it throws, so a repeat tells only what was not told; one item left is
   * told as itself.
   */
  async sendTogether(
    consumer: string,
    channel: PersonChannel,
    base: Omit<Person, 'params' | 'grantId'>,
    items: ReadonlyArray<{ eventId: string; params: Record<string, string>; grantId?: string }>,
  ): Promise<void> {
    const marked: string[] = [];
    const owed: typeof items[number][] = [];
    for (const item of items) {
      const marker = UnscopedRedisKeys.outboxProcessed(`${consumer}:${channel}`, item.eventId);
      if (!(await this.redis.setNx(marker, RedisTtl.outboxProcessed))) continue;
      marked.push(marker);
      owed.push(item);
    }
    if (owed.length === 0) return;
    try {
      if (owed.length === 1) await this.tell(channel, { ...base, params: owed[0]!.params });
      else await this.tell(channel, { ...base, params: {} }, owed.length, await this.names(base.tenantId, base.userId, owed));
    } catch (err) {
      for (const marker of marked) await this.redis.del(marker);
      throw err;
    }
  }

  /** Add the event to its burst; the call that opens a burst schedules its flush, or gives the claim back. */
  private async join(eventId: string, person: Person, window?: 'hour', only?: 'inbox'): Promise<void> {
    const { tenantId, userId, template } = person;
    const windowMs = window === 'hour' ? this.hourMs : this.windowMs;
    const scheduled = UnscopedRedisKeys.noticeBurstScheduled(tenantId, userId, template, window, only);
    const flushId = randomUUID();
    const entry: Entry = person.grantId ? { params: person.params, grantId: person.grantId } : { params: person.params };
    const claimed = await this.redis.evalScript<number>(
      NOTICE_BURST_ADD,
      [UnscopedRedisKeys.noticeBurst(tenantId, userId, template, window, only), scheduled],
      [eventId, JSON.stringify(entry), RedisTtl.outboxProcessed, Math.ceil(windowMs / 1000) + RedisTtl.noticeBurstScheduledSlack, flushId],
    );
    if (claimed !== 1) return;
    try {
      await this.broker.publishNoticeFlush({ flushId, tenantId, userId, template, ...(window ? { window } : {}), ...(only ? { only } : {}) }, windowMs);
    } catch (err) {
      await this.redis.del(scheduled);
      throw err;
    }
  }

  private async once(notice: Pick<EventNotice, 'consumer' | 'eventId'>, channel: string, effect: () => Promise<void>, failures: unknown[]): Promise<void> {
    const marker = UnscopedRedisKeys.outboxProcessed(`${notice.consumer}:${channel}`, notice.eventId);
    if (!(await this.redis.setNx(marker, RedisTtl.outboxProcessed))) {
      this.logger.debug(`outbox event ${notice.eventId} already told on ${channel}`);
      return;
    }
    try {
      await effect();
    } catch (err) {
      await this.redis.del(marker);
      this.logger.warn(`outbox event ${notice.eventId} on ${channel} failed: ${(err as Error).message}`);
      failures.push(err);
    }
  }

  /**
   * The services a combined notice lists, in its order (F-601-p) — only when
   * every item names its Grant, else `undefined`. Never throws: a lookup that
   * fails is logged and the summary is told without the list.
   */
  private async names(tenantId: string, userId: string, items: ReadonlyArray<{ grantId?: string }>): Promise<ServiceName[] | undefined> {
    const grantIds = items.map((i) => i.grantId);
    if (grantIds.some((id) => !id)) return undefined;
    try {
      if (!this.billingUrl) throw new Error('BILLING_API_BASE_URL is not set');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.billingTimeoutMs);
      try {
        const response = await fetch(`${this.billingUrl}${NAMES_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
          body: JSON.stringify({ tenantId, userId, grantIds }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`billing answered ${response.status} to ${NAMES_PATH}`);
        const items = envelopeData(await response.json())?.items;
        if (!Array.isArray(items)) throw new Error(`billing answered ${NAMES_PATH} without its items`);
        const byId = new Map((items as Array<ServiceName & { grantId: string }>).map((n) => [n.grantId, n]));
        return grantIds.map((id) => {
          const n = byId.get(id!);
          return { label: n?.label ?? null, nameKey: n?.nameKey ?? null, sku: n?.sku ?? null, labels: n?.labels ?? [] };
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.logger.warn(`combined notice for user ${userId} told without its services' names: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Throws on an unset seam or a refusal, so that channel stays owed. */
  private async tell(channel: PersonChannel, person: Person, count?: number, services?: ServiceName[]): Promise<void> {
    if (!this.baseUrl) throw new Error('AUTH_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${NOTIFY_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [RequestHeaders.serviceToken]: this.serviceToken,
          [IdentityHeaders.tenantId]: person.tenantId,
        },
        body: JSON.stringify({ userId: person.userId, channel, template: person.template, params: person.params, count, services }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`auth-api answered ${response.status} to ${NOTIFY_PATH} (${channel})`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A stored burst entry. Before F-601-p an entry was its params alone, and a
 * batch is kept for a redelivered flush (`RedisTtl.outboxProcessed`), so that
 * shape is still read; no template has a param named `params`.
 */
function entryOf(raw: string): Entry {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed['params'] && typeof parsed['params'] === 'object') return parsed as unknown as Entry;
  return { params: parsed as Record<string, string> };
}
