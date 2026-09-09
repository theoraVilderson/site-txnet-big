import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';

/** What a consumer is handed. `key` is the `<key>` of `automation.tick.<key>`. */
export interface TickMessage {
  key: string;
  /** When the publisher decided this key was due. */
  at: string;
  /** Why — `workerIsDue`'s `explain`, carried so a run log can say it. */
  reason: string;
  /** `bot_execution_log.triggeredBy`. The substrate only publishes `cron`. */
  triggeredBy: 'cron' | 'admin_manual' | 'event';
  /**
   * Whose work this is, when the tick is a tenant's rather than the platform's
   * (F-066-p, catalog 20.2 layer 4). `TenantConcurrencyGate` caps how many of
   * one tenant's ticks this process runs at once, and a tick without this field
   * is ungated — a platform sweep belongs to no tenant.
   *
   * **Optional, and unset by both publishers today.** Nothing schedules
   * per-tenant work yet; the cap is built before the first job that needs it so
   * that job does not have to arrive with a fairness policy attached.
   */
  tenantId?: string;
  /**
   * How many times the gate has already handed this tick back to the exchange.
   * It rides on the message because the process that defers a tick is not
   * necessarily the one that next receives it.
   */
  deferrals?: number;
}

export type TickHandler = (tick: TickMessage) => Promise<void>;

/**
 * The RabbitMQ connection, and the only place in this service that knows the
 * broker exists (ADR-0027).
 *
 * **Topology.** One durable topic exchange, one durable queue bound to
 * `automation.tick.#`. Durable on both halves because a tick published while
 * the consumer is restarting must survive, and a broker restart must not lose
 * the queue that would have held it.
 *
 * **Acknowledgement is manual and late.** A tick is acked after its handler
 * returns, so a process killed mid-run leaves the tick unacked and the broker
 * redelivers it. That is at-least-once, which ADR-0027 chose deliberately: a
 * job that must not run twice carries its own guard, because the queue provides
 * none.
 *
 * **A failed handler is nacked without requeue.** The alternative — requeue —
 * spins a permanently failing job at the speed of the broker, which is how a
 * bad deploy becomes an outage of everything else in the queue. The failure is
 * not lost: it is a `bot_execution_log` row with `status = failed`, which is
 * what invariant #3 asks for, and the next tick comes on the next interval
 * anyway.
 */
@Injectable()
export class BrokerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BrokerService.name);
  private connection?: amqp.ChannelModel;
  private channel?: amqp.Channel;

  private readonly url: string;
  private readonly exchange: string;
  private readonly queue: string;
  private readonly prefetch: number;

  constructor(config: ConfigService) {
    this.url = config.getOrThrow<string>('RABBITMQ_URL');
    this.exchange = config.getOrThrow<string>('AUTOMATION_EXCHANGE');
    this.queue = config.getOrThrow<string>('AUTOMATION_QUEUE');
    this.prefetch = config.getOrThrow<number>('AUTOMATION_PREFETCH');
  }

  async onModuleInit() {
    this.connection = await amqp.connect(this.url);
    this.channel = await this.connection.createChannel();

    await this.channel.assertExchange(this.exchange, 'topic', {
      durable: true,
    });
    await this.channel.assertQueue(this.queue, { durable: true });
    await this.channel.bindQueue(this.queue, this.exchange, 'automation.tick.#');
    await this.channel.prefetch(this.prefetch);

    // A dropped connection is fatal rather than retried here. The process is
    // restarted by its orchestrator, and a half-connected worker that logs an
    // error every few seconds while running nothing is the failure that hides
    // itself — this one is visible in one line and in the exit code.
    this.connection.on('error', (err: Error) =>
      this.logger.error(`broker connection error: ${err.message}`),
    );
    this.connection.on('close', () => {
      this.logger.error('broker connection closed — exiting');
      process.exit(1);
    });

    this.logger.log(
      `connected to broker; exchange=${this.exchange} queue=${this.queue} prefetch=${this.prefetch}`,
    );
  }

  /** Publish one tick. Persistent, so it survives a broker restart. */
  async publishTick(tick: TickMessage): Promise<void> {
    const channel = this.require();
    channel.publish(
      this.exchange,
      `automation.tick.${tick.key}`,
      Buffer.from(JSON.stringify(tick)),
      { persistent: true, contentType: 'application/json' },
    );
  }

  /** Start consuming. One handler for every tick; it dispatches by `key`. */
  async consumeTicks(handle: TickHandler): Promise<void> {
    const channel = this.require();
    await channel.consume(this.queue, async (message) => {
      if (message === null) return;
      let tick: TickMessage;
      try {
        tick = JSON.parse(message.content.toString()) as TickMessage;
      } catch {
        // Unparseable content can only be redelivered as unparseable. Drop it
        // rather than let it cycle for ever.
        this.logger.error('discarding a tick that is not JSON');
        channel.nack(message, false, false);
        return;
      }

      try {
        await handle(tick);
        channel.ack(message);
      } catch (err) {
        this.logger.error(
          `tick ${tick.key} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        channel.nack(message, false, false);
      }
    });
  }

  async onApplicationShutdown() {
    await this.channel?.close().catch((): void => undefined);
    await this.connection?.close().catch((): void => undefined);
  }

  private require(): amqp.Channel {
    if (!this.channel) throw new Error('broker channel is not open');
    return this.channel;
  }
}
