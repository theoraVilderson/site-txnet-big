import { OutboxEventType, type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BrokerService } from '../broker/broker.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';
import { EventNoticeSender } from './event-notice';

/** This consumer's segment of its per-channel markers (F-067-o). */
const CONSUMER = 'live-push';

/** Whose page re-reads: one user's, the operators' of one tenant (RT-1-b), or every member of it (RT-1-k). */
export type LiveAudience = 'user' | 'tenant' | 'members';

/**
 * Each live-only type: whose channels it goes to, and the payload fields its
 * body carries besides `type`. Every field named here is required: a body
 * missing one would be a page re-reading for a record it cannot name.
 */
export const LIVE_PUSH_FIELDS: Partial<Record<OutboxEventType, { audience: readonly LiveAudience[]; fields: readonly string[] }>> = {
  /** F-111-l: `network-service` captured a config's lines — the Grant's configs are ready. */
  [OutboxEventType.GRANT_LINKS_CAPTURED]: { audience: ['user'], fields: ['grantId'] },
  /** F-111-m: a wallet balance moved — the top bar re-reads it; no amount rides along. */
  [OutboxEventType.WALLET_CHANGED]: { audience: ['user'], fields: [] },
  /** F-307-t: a Grant's committed total — the row's used figure follows it, no read. */
  [OutboxEventType.GRANT_USAGE]: { audience: ['user'], fields: ['grantId', 'consumedBytes'] },
  /** F-0401-c: the user froze or unfroze their own Grant — My services re-reads the row; the act is theirs, so no notice. */
  [OutboxEventType.GRANT_FREEZE_CHANGED]: { audience: ['user'], fields: ['grantId'] },
  /**
   * RT-1-e: a reseller domain's status or edge step changed. The page is on the
   * platform's panel, so its owner (`userId`) and the platform's staff
   * (`tenantId` is the platform owner's) are who look at it.
   */
  [OutboxEventType.TENANT_DOMAIN_CHANGED]: { audience: ['user', 'tenant'], fields: ['domainId'] },
  /**
   * F-019-c1: a reseller's renewal was paid. Its owner's My services re-reads
   * the period; a paid renewal is no news worth a message, and the unpaid
   * ones are already notices (`tenant-subscription-notice`).
   */
  [OutboxEventType.TENANT_SUBSCRIPTION_RENEWED]: { audience: ['user'], fields: [] },
  /** F-019-c2: a reseller's status changed, by hand or by the platform — its owner's My services re-reads. */
  [OutboxEventType.TENANT_STATUS_CHANGED]: { audience: ['user'], fields: [] },
  /** AC-1-q: what this person may do moved — their panel refreshes its token and re-reads `me`; the cause is for the notice (AC-1-s). */
  [OutboxEventType.ACCESS_CHANGED]: { audience: ['user'], fields: [] },
  /** F-019-c3: the platform owner moved the renewal deadline — the section shows the new date. */
  [OutboxEventType.TENANT_SUBSCRIPTION_GRACE_EXTENDED]: { audience: ['user'], fields: [] },
  /** RT-1-j: one row per tenant that lists it — the payment's and the platform owner's; the page re-reads. */
  [OutboxEventType.PAYMENT_OPEN_CHANGED]: { audience: ['tenant'], fields: ['paymentId'] },
  /** F-1001-a: a rollup pass changed the tenant's analytics days `from`..`to`; the analytics page re-reads. */
  [OutboxEventType.ANALYTICS_REFRESHED]: { audience: ['tenant'], fields: ['from', 'to'] },
  /** F-1001-p: the same pass, for a reseller's workspace on the platform's panel — its owner and the platform's staff (as RT-1-e). */
  [OutboxEventType.ANALYTICS_RESELLER_REFRESHED]: { audience: ['user', 'tenant'], fields: ['resellerId', 'from', 'to'] },
  /** F-1006-a: a scheduled report was sent — its person's Reports tab re-reads the schedule's last send; the report itself is the notice's. */
  [OutboxEventType.ANALYTICS_REPORT]: { audience: ['user'], fields: ['scheduleId'] },
};

/**
 * `user:<userId>`, `tenant:<tenantId>` or `members:<tenantId>`, from the id the
 * producer put in the payload. A missing id throws — never another audience's
 * channel instead.
 */
export function liveChannel(audience: LiveAudience, payload: Record<string, unknown>, eventId: string): `${LiveAudience}:${string}` {
  const key = audience === 'user' ? 'userId' : 'tenantId';
  const id = payload[key];
  if (typeof id !== 'string' || id === '') throw new Error(`outbox event ${eventId} has a payload without its ${audience}`);
  return `${audience}:${id}`;
}

/**
 * Push an event that only an open page needs to the owner's `user:` channel
 * (F-111-l) or its tenant's `tenant:` channel (RT-1-b), and tell nobody's
 * inbox or bot.
 *
 * These are the events a page re-reads on and a person is not told about: a
 * config's lines being captured is a Grant becoming usable a few seconds after
 * "delivered" already said so, and a Grant with three configs would otherwise
 * be three messages; a wallet movement is the balance in the top bar, and the
 * reason it moved already has its own notice where one is owed. So there is
 * one queue for all of them and one consumer, and a new type is a row in
 * {@link LIVE_PUSH_FIELDS} plus its binding.
 *
 * The user or tenant is the one the producer named in the payload — never
 * looked up, never guessed — and the body is the fields the row names, nothing more: a
 * payload may carry what the producer needed, and that is not the browser's.
 */
@Injectable()
export class LivePushConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(LivePushConsumer.name);
  private readonly notices: EventNoticeSender;

  constructor(
    private readonly broker: BrokerService,
    redis: RedisService,
    realtime: RealtimePublisher,
    config: ConfigService,
  ) {
    this.notices = new EventNoticeSender(redis, realtime, config, broker);
  }

  async onApplicationBootstrap() {
    await this.broker.consumeLivePushes((event) => this.handle(event));
    this.logger.log(`consuming ${Object.keys(LIVE_PUSH_FIELDS).join(', ')} for open pages`);
  }

  async handle(event: OutboxMessage): Promise<void> {
    const row = LIVE_PUSH_FIELDS[event.type as OutboxEventType];
    if (!row) throw new Error(`outbox event ${event.id} of type ${event.type} has no live push row`);
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : null);
    const channels = row.audience.map((audience) => [audience, liveChannel(audience, p, event.id)] as const);
    const body: Record<string, unknown> = { type: event.type };
    for (const field of row.fields) {
      const value = str(field);
      if (!value) throw new Error(`outbox event ${event.id} has a payload without its ${field}`);
      body[field] = value;
    }
    // One marker per audience, so a replay after a failed second push repeats only that one.
    for (const [audience, channel] of channels) {
      await this.notices.send({ consumer: audience === 'user' ? CONSUMER : `${CONSUMER}-${audience}`, eventId: event.id, live: { channel, body } });
    }
  }
}
