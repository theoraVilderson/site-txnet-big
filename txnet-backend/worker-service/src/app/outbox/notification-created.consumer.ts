import { OutboxEventType, RedisTtl, UnscopedRedisKeys, type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { BrokerService } from '../broker/broker.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';

/** This consumer's segment of the processed-event key (ADR-0045). */
const CONSUMER = 'notification-created-live';

/** `notification-service`'s `notification.created` payload (`NotificationInboxService.create`). */
type NotificationCreated = { userId: string; notification: { id: string } & Record<string, unknown> };

/**
 * Push a new inbox row to its owner's open panel (F-035-b).
 *
 * The payer notices' dedupe (ADR-0045): the marker is `SET NX` before the
 * publish, so a redelivered event does not add the item twice. The publish is
 * the only side effect and `RealtimePublisher` never throws, so there is no
 * marker to give back — a panel that was closed reads the row on its next
 * page load, which is why the live half may be at most once.
 */
@Injectable()
export class NotificationCreatedConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(NotificationCreatedConsumer.name);

  constructor(
    private readonly broker: BrokerService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimePublisher,
  ) {}

  async onApplicationBootstrap() {
    await this.broker.consumeNotificationCreated((event) => this.handle(event));
    this.logger.log('consuming notification.created for the live inbox');
  }

  async handle(event: OutboxMessage): Promise<void> {
    const created = createdOf(event);

    const marker = UnscopedRedisKeys.outboxProcessed(CONSUMER, event.id);
    if (!(await this.redis.setNx(marker, RedisTtl.outboxProcessed))) {
      this.logger.debug(`outbox event ${event.id} already handled`);
      return;
    }

    await this.realtime.publish(`user:${created.userId}`, {
      type: OutboxEventType.NOTIFICATION_CREATED,
      notification: created.notification,
    });
  }
}

/** The payload, or a throw: an event that does not say whose row it is is not one to guess about. */
function createdOf(event: OutboxMessage): NotificationCreated {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const userId = typeof p.userId === 'string' && p.userId !== '' ? p.userId : null;
  const notification = p.notification as NotificationCreated['notification'] | undefined;
  if (!userId || !notification || typeof notification.id !== 'string' || notification.id === '') {
    throw new Error(`outbox event ${event.id} has a payload without its user or notification`);
  }
  return { userId, notification };
}
