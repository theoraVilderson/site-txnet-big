import { randomUUID } from 'node:crypto';

import { IdentityHeaders, RedisTtl, RequestHeaders, UnscopedRedisKeys } from '@txnet-backend/shared-core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { BrokerService, NoticeFlush } from '../broker/broker.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';

export type { NoticeFlush } from '../broker/broker.service';

/** auth-service's seam for telling a user a named notice (ADR-0045 decision 2). */
const NOTIFY_PATH = '/api/internal/notify/user';

/** The seam's channels, in the order they are tried after the live push. */
const PERSON_CHANNELS = ['inbox', 'bot'] as const;

/** The marker segment of a combined notice's channels; the flush id is the "event" (F-067-p). */
const BURST_CONSUMER = 'notice-burst';

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

type Person = { tenantId: string; userId: string; template: string; params: Record<string, string> };

/**
 * One event, told (F-067-o, ADR-0084 decision 2). `consumer` is the notice's
 * segment of its markers; `live` is the push to every open device;
 * `person` is the one user told in their inbox and on their bot — for a
 * tenant-audience event, the tenant's `ownerUserId`. The words are
 * auth-service's, in that user's language.
 */
export type EventNotice = {
  consumer: string;
  eventId: string;
  live?: { channel: `user:${string}` | `tenant:${string}`; body: Record<string, unknown> };
  person?: Person;
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
 */
export class EventNoticeSender {
  private readonly logger = new Logger(EventNoticeSender.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;
  private readonly windowMs: number;

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
  }

  async send(notice: EventNotice): Promise<void> {
    const failures: unknown[] = [];
    const { live, person } = notice;
    if (live) await this.once(notice, 'live', () => this.realtime.publish(live.channel, live.body), failures);
    if (person) {
      const owed = await this.owedBeforeBursts(notice);
      if (owed === null) await this.once(notice, 'person', () => this.join(notice.eventId, person), failures);
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
  private async owedBeforeBursts(notice: EventNotice): Promise<(typeof PERSON_CHANNELS)[number][] | null> {
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
    const { flushId, tenantId, userId, template } = flush;
    const flat = await this.redis.evalScript<string[]>(
      NOTICE_BURST_TAKE,
      [
        UnscopedRedisKeys.noticeBurstScheduled(tenantId, userId, template),
        UnscopedRedisKeys.noticeBurst(tenantId, userId, template),
        UnscopedRedisKeys.noticeBurstBatch(flushId),
      ],
      [RedisTtl.outboxProcessed, flushId],
    );
    const count = flat.length / 2;
    if (count === 0) return;
    const person: Person = { tenantId, userId, template, params: count === 1 ? (JSON.parse(flat[1]!) as Record<string, string>) : {} };
    const failures: unknown[] = [];
    const told = { consumer: BURST_CONSUMER, eventId: flushId };
    for (const channel of PERSON_CHANNELS) {
      await this.once(told, channel, () => this.tell(channel, person, count > 1 ? count : undefined), failures);
    }
    if (failures.length > 0) throw failures[0];
  }

  /** Add the event to its burst; the call that opens a burst schedules its flush, or gives the claim back. */
  private async join(eventId: string, person: Person): Promise<void> {
    const { tenantId, userId, template } = person;
    const scheduled = UnscopedRedisKeys.noticeBurstScheduled(tenantId, userId, template);
    const flushId = randomUUID();
    const claimed = await this.redis.evalScript<number>(
      NOTICE_BURST_ADD,
      [UnscopedRedisKeys.noticeBurst(tenantId, userId, template), scheduled],
      [eventId, JSON.stringify(person.params), RedisTtl.outboxProcessed, Math.ceil(this.windowMs / 1000) + RedisTtl.noticeBurstScheduledSlack, flushId],
    );
    if (claimed !== 1) return;
    try {
      await this.broker.publishNoticeFlush({ flushId, tenantId, userId, template }, this.windowMs);
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

  /** Throws on an unset seam or a refusal, so that channel stays owed. */
  private async tell(channel: (typeof PERSON_CHANNELS)[number], person: Person, count?: number): Promise<void> {
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
        body: JSON.stringify({ userId: person.userId, channel, template: person.template, params: person.params, count }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`auth-api answered ${response.status} to ${NOTIFY_PATH} (${channel})`);
    } finally {
      clearTimeout(timer);
    }
  }
}
