import { OutboxEventType, type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BrokerService } from '../broker/broker.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';
import { EventNoticeSender } from './event-notice';

/** This consumer's segment of its per-channel markers (F-067-o). */
const CONSUMER = 'live-push';

/**
 * Each live-only type, and the payload fields its body carries besides `type`.
 * Every field named here is required: a body missing one would be a page
 * re-reading for a record it cannot name.
 */
export const LIVE_PUSH_FIELDS: Partial<Record<OutboxEventType, readonly string[]>> = {
  /** F-111-l: `network-service` captured a config's lines — the Grant's configs are ready. */
  [OutboxEventType.GRANT_LINKS_CAPTURED]: ['grantId'],
  /** F-111-m: a wallet balance moved — the top bar re-reads it; no amount rides along. */
  [OutboxEventType.WALLET_CHANGED]: [],
};

/**
 * Push an event that only an open page needs to the owner's `user:` channel
 * (F-111-l), and tell nobody's inbox or bot.
 *
 * These are the events a page re-reads on and a person is not told about: a
 * config's lines being captured is a Grant becoming usable a few seconds after
 * "delivered" already said so, and a Grant with three configs would otherwise
 * be three messages; a wallet movement is the balance in the top bar, and the
 * reason it moved already has its own notice where one is owed. So there is
 * one queue for all of them and one consumer, and a new type is a row in
 * {@link LIVE_PUSH_FIELDS} plus its binding.
 *
 * The user is the one the producer named in the payload — never looked up,
 * never guessed — and the body is the fields the row names, nothing more: a
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
    const fields = LIVE_PUSH_FIELDS[event.type as OutboxEventType];
    if (!fields) throw new Error(`outbox event ${event.id} of type ${event.type} has no live push row`);
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : null);
    const userId = str('userId');
    if (!userId) throw new Error(`outbox event ${event.id} has a payload without its user`);
    const body: Record<string, unknown> = { type: event.type };
    for (const field of fields) {
      const value = str(field);
      if (!value) throw new Error(`outbox event ${event.id} has a payload without its ${field}`);
      body[field] = value;
    }
    await this.notices.send({ consumer: CONSUMER, eventId: event.id, live: { channel: `user:${userId}`, body } });
  }
}
