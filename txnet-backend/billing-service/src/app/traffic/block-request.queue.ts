import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import {
  BLOCK_REQUEST_ROUTING_KEY,
  NETWORK_USAGE_ROUTING_PREFIX,
  blockRequestMessageSchema,
  topicBindingAll,
} from '@txnet-backend/shared-core';

import { BlockRequestService } from './block-request';

/**
 * The broker end of the lease planner's block requests (F-027-dc, ADR-0093),
 * and the only place in `billing-service` that knows RabbitMQ exists. A
 * request is the only thing that buys a metered block (`block-request.ts`).
 *
 * **What is left of the hot loop's queue** (F-027-cl, retired by F-027-dk).
 * The durable queue keeps its name (`HOT_LOOP_QUEUE`) and so its binding on
 * `network.usage.#`, which the broker holds whatever this code asks for. Boot
 * therefore unbinds it: left bound, every collection pass would still land
 * here, to be acked unread. Renaming the queue instead would orphan the old
 * one, still bound, filling with nobody reading it.
 *
 * **Prefetch is one**: a Grant's two requests handled at once would both read
 * the bag before either bought, and the stale-bag guard would have to catch
 * what ordering catches for free.
 *
 * **Acknowledgement is manual and late**, and a failed request is nacked
 * without requeue onto the dead-letter exchange, as `metering-service` does:
 * nothing is owed by it — the planner asks again inside `BlockRetry` — but it
 * is kept as the evidence of what failed. A message that does not parse
 * dead-letters at once; redelivery cannot make it parse.
 */
@Injectable()
export class BlockRequestQueue implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BlockRequestQueue.name);
  private connection?: amqp.ChannelModel;
  private channel?: amqp.Channel;

  private readonly url: string;
  private readonly exchange: string;
  private readonly queue: string;
  private readonly deadExchange: string;

  /** Set when this service closes the connection itself, so its `close` is not read as the broker's. */
  private stopping = false;

  constructor(
    config: ConfigService,
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
    await channel.unbindQueue(this.queue, this.exchange, topicBindingAll(NETWORK_USAGE_ROUTING_PREFIX));
    await channel.bindQueue(this.queue, this.exchange, BLOCK_REQUEST_ROUTING_KEY);
    await channel.prefetch(1);

    // Fatal rather than retried, for metering-service's reason: a consumer that
    // logs while consuming nothing hides itself — here as metered Grants whose
    // bag nobody refills.
    this.connection.on('error', (err: Error) => this.logger.error(`broker connection error: ${err.message}`));
    this.connection.on('close', () => {
      // Our own close (a deploy, a dev reload) is not the broker going away.
      if (this.stopping) return;
      this.logger.error('broker connection closed — exiting');
      process.exit(1);
    });

    await channel.consume(this.queue, async (message) => {
      if (message === null) return;
      // Anything else is a collection pass bound here before F-027-dk, still
      // queued: it is nobody's now, and is acked unread.
      if (message.fields.routingKey !== BLOCK_REQUEST_ROUTING_KEY) {
        channel.ack(message);
        return;
      }
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
    });

    this.logger.log(
      `block requests consuming ${this.queue}; exchange=${this.exchange} binding=${BLOCK_REQUEST_ROUTING_KEY} prefetch=1 dlx=${this.deadExchange}`,
    );
  }

  async onApplicationShutdown() {
    this.stopping = true;
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
