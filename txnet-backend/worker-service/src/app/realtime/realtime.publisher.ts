import { Injectable, Logger } from '@nestjs/common';
import { encodeRealtimeFanout } from '@txnet-backend/shared-core';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis.keys';

/**
 * The producing half of the realtime fan-out (F-067-i).
 *
 * A job or a queue consumer that finished work the user is waiting for calls
 * this; the gateway replica holding that user's socket — and only it —
 * delivers. Neither process knows the other exists: they agree on a channel
 * name, which is `shared-core/realtime/fanout.ts`.
 *
 * **What this is not.** It is not the broker, and the difference is the point.
 * Every message `worker-service` puts on RabbitMQ is durable, acked, and
 * dead-lettered when it cannot be handled (F-067-d). A realtime event is the
 * opposite by contract: at-most-once, dropped when nobody is connected, with
 * the durable record — where the feature has one — kept by the producing
 * domain instead (D-15 keeps the OTP delivery status in Redis for exactly
 * this). Sending it through the broker would give it durability the contract
 * does not want and a dead-letter queue slowly filling with events for people
 * who closed a laptop.
 *
 * **Delivery is not confirmed and cannot be.** `publish` answers how many
 * subscribers Redis handed the message to, which says nothing about whether
 * the socket wrote it, and zero is the ordinary answer for a user who is not
 * connected. So a caller must never treat this as the record that something
 * happened — it is the notification that it did.
 */
@Injectable()
export class RealtimePublisher {
  private readonly logger = new Logger(RealtimePublisher.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Send `payload` to everyone subscribed to `channel` — `user:<userId>` or
   * `tenant:<tenantId>` (`realtime/contract.md`).
   *
   * Authorization is not asked here and must not be: who may hear a channel
   * is decided once, at subscribe time, in the gateway. A producer naming a
   * channel is naming an address, and adding a second opinion about it here
   * would be a second place for the rule to be wrong.
   *
   * A failed publish is logged and swallowed. The caller is finishing real
   * work — an OTP was sent, a payment was confirmed — and a Redis that is
   * unreachable must not turn that into a failure of the work itself; the
   * client falls back to the state the producing domain stored, which is what
   * it does after any missed event.
   */
  async publish(channel: string, payload: unknown): Promise<void> {
    // The prefix by hand: ioredis applies `keyPrefix` to keys, and a pub/sub
    // channel is not one. Publishing unprefixed reaches no subscriber and
    // reports success.
    const wire = `${this.redis.keyPrefix}${RedisKeys.realtimeFanout(channel)}`;
    try {
      await this.redis.publish(wire, encodeRealtimeFanout(payload));
    } catch (err) {
      this.logger.error(
        `could not publish a realtime event on ${channel}: ${
          (err as Error).message
        }`,
      );
    }
  }
}
