import { IdentityHeaders, RedisTtl, RequestHeaders, UnscopedRedisKeys } from '@txnet-backend/shared-core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';

/** auth-service's seam for telling a user a named notice (ADR-0045 decision 2). */
const NOTIFY_PATH = '/api/internal/notify/user';

/** The seam's channels, in the order they are tried after the live push. */
const PERSON_CHANNELS = ['inbox', 'bot'] as const;

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
  person?: { tenantId: string; userId: string; template: string; params: Record<string, string> };
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
 */
export class EventNoticeSender {
  private readonly logger = new Logger(EventNoticeSender.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly redis: RedisService,
    private readonly realtime: RealtimePublisher,
    config: ConfigService,
  ) {
    this.baseUrl = config.get<string>('AUTH_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 30_000);
  }

  async send(notice: EventNotice): Promise<void> {
    const failures: unknown[] = [];
    const { live, person } = notice;
    if (live) await this.once(notice, 'live', () => this.realtime.publish(live.channel, live.body), failures);
    if (person) {
      for (const channel of PERSON_CHANNELS) await this.once(notice, channel, () => this.tell(channel, person), failures);
    }
    if (failures.length > 0) throw failures[0];
  }

  private async once(notice: EventNotice, channel: string, effect: () => Promise<void>, failures: unknown[]): Promise<void> {
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
  private async tell(channel: (typeof PERSON_CHANNELS)[number], person: NonNullable<EventNotice['person']>): Promise<void> {
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
        body: JSON.stringify({ userId: person.userId, channel, template: person.template, params: person.params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`auth-api answered ${response.status} to ${NOTIFY_PATH} (${channel})`);
    } finally {
      clearTimeout(timer);
    }
  }
}
