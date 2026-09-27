import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import {
  BLOCK_REQUEST_ROUTING_KEY,
  NETWORK_USAGE_ROUTING_PREFIX,
  USAGE_DELTA_ROUTING_KEY,
  blockRequestMessageSchema,
  topicBindingAll,
  usageDeltaMessageSchema,
} from '@txnet-backend/shared-core';

import { BlockRequestService } from './block-request';
import { HotLoopConsumer } from './hot-loop.consumer';

/**
 * The broker end of the hot loop's caller (F-027-cl, ADR-0092), and the only
 * place in `billing-service` that knows RabbitMQ exists.
 *
 * **Its own queue on `network.usage.#`**, beside `metering-service`'s, not a
 * share of it: both need every pass, and a topic exchange copies the message
 * to each bound queue. Billing a delta and topping up the Grant it touched are
 * two consumers of one fact, and neither waits for the other.
 *
 * **Prefetch is one, and not configurable.** `HotLoopService` measures a
 * config's rate between two of its own passes, in memory; two passes over the
 * same panel handled at once would measure each other's gap. The work behind a
 * message is a transaction per Grant it touched, so one at a time keeps up.
 *
 * **Acknowledgement is manual and late**, and a failed pass is nacked without
 * requeue onto the dead-letter exchange, as `metering-service` does: nothing is
 * owed by a dead-lettered pass here — the next one re-reads the same rows —
 * but it is kept as the evidence of what failed. A message that does not parse
 * dead-letters at once; redelivery cannot make it parse.
 *
 * **The lease planner's block requests ride the same queue** (F-027-dc), bound
 * by their own key: one consumer at prefetch one, so a request and the pass
 * that measured it are never handled at once. A request is the only thing
 * that buys a metered block (`block-request.ts`).
 */
@Injectable()
export class HotLoopQueue implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(HotLoopQueue.name);
  private connection?: amqp.ChannelModel;
  private channel?: amqp.Channel;

  private readonly url: string;
  private readonly exchange: string;
  private readonly queue: string;
  private readonly deadExchange: string;

  constructor(
    config: ConfigService,
    private readonly consumer: HotLoopConsumer,
    private readonly blockRequests: BlockRequestService,
  ) {
    this.url = config.getOrThrow<string>('RABBITMQ_URL');
    this.exchange = config.getOrThrow<string>('AUTOMATION_EXCHANGE');
    this.queue = config.getOrThrow<string>('HOT_LOOP_QUEUE');
    this.deadExchange = config.getOrThrow<string>('AUTOMATION_DLX');
  }

  async onApplicationBootstrap() {
    this.connection = await amqp.connect(this.url);
    const channel = await this.connection.createChannel();
    this.channel = channel;

    await channel.assertExchange(this.exchange, 'topic', { durable: true });
    // Declared, not assumed: this service may boot before worker-service does,
    // and a queue naming a dead-letter exchange that does not exist yet drops
    // what it rejects.
    await channel.assertExchange(this.deadExchange, 'topic', { durable: true });
    await channel.assertQueue(this.queue, { durable: true, arguments: { 'x-dead-letter-exchange': this.deadExchange } });
    await channel.bindQueue(this.queue, this.exchange, topicBindingAll(NETWORK_USAGE_ROUTING_PREFIX));
    await channel.bindQueue(this.queue, this.exchange, BLOCK_REQUEST_ROUTING_KEY);
    await channel.prefetch(1);

    // Fatal rather than retried, for metering-service's reason: a consumer that
    // logs while consuming nothing hides itself — here as Grants cut off at a
    // share nobody moves.
    this.connection.on('error', (err: Error) => this.logger.error(`broker connection error: ${err.message}`));
    this.connection.on('close', () => {
      this.logger.error('broker connection closed — exiting');
      process.exit(1);
    });

    await channel.consume(this.queue, async (message) => {
      if (message === null) return;
      if (message.fields.routingKey === BLOCK_REQUEST_ROUTING_KEY) {
        const request = blockRequestMessageSchema.safeParse(safeJson(message.content));
        if (!request.success) {
          this.logger.error(`dead-lettering a block request that is not valid: ${request.error.message}`);
          channel.nack(message, false, false);
          return;
        }
        try {
          const handled = await this.blockRequests.handle(request.data);
          if (handled.outcome !== 'handled') this.logger.debug(`block request for grant ${handled.grantId}: ${handled.outcome}`);
          channel.ack(message);
        } catch (err) {
          this.logger.error(`block request for grant ${request.data.grantId} failed: ${err instanceof Error ? err.message : String(err)}`);
          channel.nack(message, false, false);
        }
        return;
      }
      // Only a collection pass is the hot loop's. Anything else under the
      // prefix is another consumer's, and is acked unread.
      if (message.fields.routingKey !== USAGE_DELTA_ROUTING_KEY) {
        channel.ack(message);
        return;
      }
      const parsed = usageDeltaMessageSchema.safeParse(safeJson(message.content));
      if (!parsed.success) {
        this.logger.error(`dead-lettering a usage delta that is not a valid pass: ${parsed.error.message}`);
        channel.nack(message, false, false);
        return;
      }
      try {
        const pass = await this.consumer.handle(parsed.data);
        if (pass.raced > 0) this.logger.debug(`panel ${parsed.data.panelId}: ${pass.raced} of ${pass.grants} Grants bought for by another pass`);
        channel.ack(message);
      } catch (err) {
        this.logger.error(err instanceof Error ? err.message : String(err));
        channel.nack(message, false, false);
      }
    });

    this.logger.log(
      `hot loop consuming ${this.queue}; exchange=${this.exchange} binding=${topicBindingAll(NETWORK_USAGE_ROUTING_PREFIX)},${BLOCK_REQUEST_ROUTING_KEY} prefetch=1 dlx=${this.deadExchange}`,
    );
  }

  async onApplicationShutdown() {
    await this.channel?.close().catch((): void => undefined);
    await this.connection?.close().catch((): void => undefined);
  }
}

/** `undefined` rather than a throw: the schema reports both failures the same way. */
function safeJson(content: Buffer): unknown {
  try {
    return JSON.parse(content.toString());
  } catch {
    return undefined;
  }
}
