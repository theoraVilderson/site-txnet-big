import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';

import type { EnvConfig } from '../config/env.validation';
import { AI_TRIGGER_ROUTING_KEYS, triggerMessageSchema, type TriggerMessage } from '../triggers/trigger-events';

export type TriggerHandler = (message: TriggerMessage) => Promise<void>;

/**
 * The RabbitMQ connection — the only place in `ai-service` that knows the
 * broker exists. Same discipline as `metering-service`'s:
 *
 * - **Its own durable queue**, bound to the trigger keys on the automation
 *   exchange. A topic exchange copies each event to every bound queue, so
 *   this binding adds a reader and takes nothing from `worker-service`.
 * - **Ack late, nack to the DLX without requeue.** A handler that throws
 *   would throw again; requeueing at broker speed is how one bad event
 *   becomes a busy loop on a one-CPU container.
 * - **An envelope that does not parse dead-letters at once.**
 * - **A dropped connection exits the process**, so compose restarts it rather
 *   than leaving a consumer that consumes nothing.
 */
@Injectable()
export class BrokerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BrokerService.name);
  private connection?: amqp.ChannelModel;
  private channel?: amqp.Channel;
  private stopping = false;

  constructor(private readonly config: ConfigService<EnvConfig, true>) {}

  async onModuleInit() {
    const exchange = this.config.get('AUTOMATION_EXCHANGE', { infer: true });
    const deadExchange = this.config.get('AUTOMATION_DLX', { infer: true });
    const queue = this.config.get('AI_QUEUE', { infer: true });

    this.connection = await amqp.connect(this.config.get('RABBITMQ_URL', { infer: true }));
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange(exchange, 'topic', { durable: true });
    await this.channel.assertExchange(deadExchange, 'topic', { durable: true });
    await this.channel.assertQueue(queue, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': deadExchange },
    });
    for (const key of AI_TRIGGER_ROUTING_KEYS) {
      await this.channel.bindQueue(queue, exchange, key);
    }
    await this.channel.prefetch(this.config.get('AI_PREFETCH', { infer: true }));

    this.connection.on('error', (err: Error) => this.logger.error(`broker connection error: ${err.message}`));
    this.connection.on('close', () => {
      if (this.stopping) return;
      this.logger.error('broker connection closed — exiting');
      process.exit(1);
    });
    this.logger.log(`connected to broker; exchange=${exchange} queue=${queue} keys=${AI_TRIGGER_ROUTING_KEYS.length} dlx=${deadExchange}`);
  }

  async consumeTriggers(handle: TriggerHandler): Promise<void> {
    const channel = this.require();
    await channel.consume(this.config.get('AI_QUEUE', { infer: true }), async (message) => {
      if (message === null) return;
      const parsed = triggerMessageSchema.safeParse(safeJson(message.content));
      if (!parsed.success) {
        this.logger.error(`dead-lettering a trigger that is not a valid outbox message: ${parsed.error.message}`);
        channel.nack(message, false, false);
        return;
      }
      try {
        await handle(parsed.data);
        channel.ack(message);
      } catch (err) {
        this.logger.error(`trigger ${parsed.data.type} ${parsed.data.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        channel.nack(message, false, false);
      }
    });
  }

  async onApplicationShutdown() {
    this.stopping = true;
    await this.channel?.close().catch((): void => undefined);
    await this.connection?.close().catch((): void => undefined);
  }

  private require(): amqp.Channel {
    if (!this.channel) throw new Error('broker channel is not open');
    return this.channel;
  }
}

function safeJson(content: Buffer): unknown {
  try {
    return JSON.parse(content.toString());
  } catch {
    return undefined;
  }
}
