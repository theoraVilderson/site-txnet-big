import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import {
  botUpdateQueueName,
  BOT_UPDATE_ROUTING_PREFIX,
  confirmedPublisher,
  type ConfirmedPublish,
  type OutboxMessage,
} from '@txnet-backend/shared-core';

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

/** What a dead-letter consumer is handed: one message, and nothing decoded. */
export interface DeadMessage {
  routingKey: string;
  content: Buffer;
  headers: Record<string, unknown>;
}

export type DeadLetterHandler = (message: DeadMessage) => Promise<void>;

/**
 * The request to send one OTP (F-067-a). It carries **no code**: the code is
 * drawn by whoever sends it, so that it never exists at rest anywhere but as
 * its argon2id hash (identity/invariants.md #2).
 *
 * Written out here rather than imported for the reason `TickMessage` is: the
 * publisher lives in another Nx app, and the wire between the two is the
 * exchange and the fields on it.
 */
export interface OtpDeliveryMessage {
  tenantId: string;
  phoneNumber: string;
  purpose: string;
  channel: string;
  requestIp: string;
  lang: string;
  deliveryId: string;
  /** The realtime channel the result is published to (F-067-j). */
  channelId: string;
}

export type OtpDeliveryHandler = (
  message: OtpDeliveryMessage,
) => Promise<void>;

/**
 * One bot update, off one of the queues in the set (F-067-b).
 *
 * Deliberately opaque past the two fields this process uses. The body is
 * `bot-service`'s `BotUpdateMessage` and it is forwarded there whole: this
 * service does not read a conversation, and typing out its fields here would
 * be a second copy to keep in step for no caller. `chatId` is for the log line
 * and `webhookPath` names the bot — never the tenant, which is resolved from
 * that path in the process that owns the lookup.
 */
export interface BotUpdateMessage {
  chatId?: string;
  webhookPath?: string;
  [field: string]: unknown;
}

export type BotUpdateHandler = (message: BotUpdateMessage) => Promise<void>;

/**
 * The header every publish stamps with how many times this message has been
 * published. It is read back by `deadLetterRecordOf` (F-067-d), and it lives
 * here because the publisher is what sets it.
 */
export const ATTEMPTS_HEADER = 'x-attempts';

/**
 * Ends a message without claiming its job failed.
 *
 * A tick the tenant gate gave up on never started, so recording it as a failed
 * run would put a lie in `bot_execution_log`. It must still leave the queue
 * through the dead-letter path rather than be acked into nothing, which is what
 * happened before F-067-d.
 */
export class DeadLetterError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'DeadLetterError';
  }
}

/**
 * The RabbitMQ connection, and the only place in this service that knows the
 * broker exists (ADR-0027).
 *
 * **Topology.** One durable topic exchange and three sets of queues on it: the
 * tick queue bound to `automation.tick.#`, the OTP delivery queue bound to
 * `otp.delivery.#` (F-067-a), and the bot-update set, one queue per slot bound
 * to its own `bot.update.<slot>` (F-067-b). Durable everywhere, because a
 * message published while a consumer is restarting must survive, and a broker
 * restart must not lose the queue that would have held it.
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
 *
 * **And it is not destroyed either (F-067-d).** The queue carries
 * `x-dead-letter-exchange`, so every rejected message — a failed handler,
 * a body that is not JSON, a tick the tenant gate gave up on — is moved by the
 * broker to the dead-letter queue instead of being dropped. That argument used
 * to rest on a tick recurring; an OTP, an outbox event or a bot update does not
 * recur, and every row that puts one on this broker depends on this path.
 *
 * **The channel is a confirm channel (F-067-f).** A plain publish is answered by
 * nothing, so a broker that took the frame and dropped it reported success. Every
 * publish here is awaited through `confirmedPublisher` and is `mandatory`, so a
 * message that reached no queue fails its caller instead of vanishing.
 */
@Injectable()
export class BrokerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BrokerService.name);
  private connection?: amqp.ChannelModel;
  private channel?: amqp.ConfirmChannel;
  private publish?: ConfirmedPublish;

  private readonly url: string;
  private readonly exchange: string;
  private readonly queue: string;
  private readonly prefetch: number;
  private readonly deadExchange: string;
  private readonly deadQueue: string;
  private readonly otpQueue: string;
  private readonly botUpdatePrefix: string;
  private readonly botUpdateQueues: number;
  private readonly confirmMs: number;
  /** One channel per bot-update queue — see {@link consumeBotUpdates}. */
  private readonly botUpdateChannels: amqp.Channel[] = [];

  constructor(config: ConfigService) {
    this.url = config.getOrThrow<string>('RABBITMQ_URL');
    this.exchange = config.getOrThrow<string>('AUTOMATION_EXCHANGE');
    this.queue = config.getOrThrow<string>('AUTOMATION_QUEUE');
    this.prefetch = config.getOrThrow<number>('AUTOMATION_PREFETCH');
    this.deadExchange = config.getOrThrow<string>('AUTOMATION_DLX');
    this.deadQueue = config.getOrThrow<string>('AUTOMATION_DEAD_QUEUE');
    this.otpQueue = config.getOrThrow<string>('AUTOMATION_OTP_QUEUE');
    this.botUpdatePrefix = config.getOrThrow<string>('BOT_UPDATE_QUEUE_PREFIX');
    this.botUpdateQueues = config.getOrThrow<number>('BOT_UPDATE_QUEUES');
    this.confirmMs = config.getOrThrow<number>('AUTOMATION_PUBLISH_CONFIRM_MS');
  }

  async onModuleInit() {
    this.connection = await amqp.connect(this.url);
    this.channel = await this.connection.createConfirmChannel();
    this.publish = confirmedPublisher(this.channel, this.confirmMs);

    await this.channel.assertExchange(this.exchange, 'topic', {
      durable: true,
    });

    // The dead-letter half first, because the main queue names it. Durable on
    // both halves for the reason the main pair is: a message that outlived the
    // process that could not handle it must outlive a broker restart too.
    await this.channel.assertExchange(this.deadExchange, 'topic', {
      durable: true,
    });
    await this.channel.assertQueue(this.deadQueue, { durable: true });
    await this.channel.bindQueue(this.deadQueue, this.deadExchange, '#');

    // No `x-dead-letter-routing-key`: a dead message keeps the
    // `automation.tick.<key>` it was published with, so the row written for it
    // says which worker it belonged to without anyone having to parse a body.
    await this.channel.assertQueue(this.queue, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': this.deadExchange },
    });
    await this.channel.bindQueue(this.queue, this.exchange, 'automation.tick.#');

    // OTP delivery gets its own queue on the same exchange (F-067-a). Its own,
    // because a slow SMS provider must not sit in front of a tick and because
    // the two have different depths worth alerting on (F-067-g); the same
    // exchange, because that is what a topic exchange is for, and a second one
    // would be a second thing to declare, monitor and dead-letter for nothing.
    await this.channel.assertQueue(this.otpQueue, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': this.deadExchange },
    });
    await this.channel.bindQueue(this.otpQueue, this.exchange, 'otp.delivery.#');

    // The bot-update set (F-067-b, D-16). One queue per slot, each bound to
    // exactly its own routing key — not one queue on `bot.update.#`, which
    // would put every chat back in a single line and lose the whole point.
    // Declared here rather than by the publisher: how many consumers there are
    // is this side's business, and `bot-service` only needs the count to
    // address them.
    for (let slot = 0; slot < this.botUpdateQueues; slot++) {
      const queue = botUpdateQueueName(this.botUpdatePrefix, slot);
      await this.channel.assertQueue(queue, {
        durable: true,
        arguments: { 'x-dead-letter-exchange': this.deadExchange },
      });
      await this.channel.bindQueue(
        queue,
        this.exchange,
        `${BOT_UPDATE_ROUTING_PREFIX}${slot}`,
      );
    }

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
      `connected to broker; exchange=${this.exchange} queue=${this.queue} ` +
        `prefetch=${this.prefetch} dlx=${this.deadExchange} dead-queue=${this.deadQueue} ` +
        `bot-update-queues=${this.botUpdateQueues}`,
    );
  }

  /**
   * Publish one tick. Persistent, so it survives a broker restart.
   *
   * `attempts` counts publishes of this tick, not deliveries of it, and it
   * rides on the message because the process that re-publishes a deferred tick
   * is not necessarily the one that next receives it. A dead-letter row reads
   * it (F-067-d) so the twentieth attempt does not look like the first.
   */
  async publishTick(tick: TickMessage, attempts = 1): Promise<void> {
    if (!this.publish) throw new Error('broker channel is not open');
    await this.publish(
      this.exchange,
      `automation.tick.${tick.key}`,
      Buffer.from(JSON.stringify(tick)),
      {
        persistent: true,
        contentType: 'application/json',
        headers: { [ATTEMPTS_HEADER]: attempts },
      },
    );
  }

  /**
   * Publish one outbox event (F-067-c, ADR-0021).
   *
   * The routing key is passed in rather than derived here: `type` is a column
   * a producing domain writes, and the place that turns an untrusted column
   * into an address is the relay, which is also the place that can record on
   * the row why it could not (`OutboxRelayJob`).
   *
   * `messageId` is the event's own id, which is the idempotency key ADR-0021
   * requires of every consumer — delivery is at-least-once, so a consumer must
   * be able to recognise an event it has already handled before it parses the
   * body. `confirmedPublisher` would otherwise invent a correlation id here,
   * and a correlation id is not an identity.
   */
  async publishOutboxEvent(
    routingKey: string,
    event: OutboxMessage,
  ): Promise<void> {
    if (!this.publish) throw new Error('broker channel is not open');
    await this.publish(
      this.exchange,
      routingKey,
      Buffer.from(JSON.stringify(event)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: event.id,
      },
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
        // Unparseable content can only be redelivered as unparseable, so it is
        // still rejected without requeue — but since F-067-d that rejection
        // moves it to the dead-letter queue instead of destroying it. What the
        // body was is the only evidence left about who sent it.
        this.logger.error('dead-lettering a tick that is not JSON');
        channel.nack(message, false, false);
        return;
      }

      try {
        await handle(tick);
        channel.ack(message);
      } catch (err) {
        if (err instanceof DeadLetterError) {
          // Not a failed run: the handler decided this message is finished
          // without ever starting it. Same rejection, a different log line, so
          // the two are not confused by whoever reads them.
          this.logger.error(
            `dead-lettering tick ${tick.key}: ${err.message}`,
          );
        } else {
          this.logger.error(
            `tick ${tick.key} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        channel.nack(message, false, false);
      }
    });
  }

  /**
   * Start consuming OTP delivery requests (F-067-a).
   *
   * The same rules as `consumeTicks`: acked late, nacked without requeue so a
   * failure dead-letters rather than spins. A handler that throws is a
   * delivery the operator has to see; a delivery that simply cannot succeed —
   * an unlinked messenger, an unconfigured channel — is not a throw, because
   * the sending side records it as `failed` and returns, and redelivering it
   * would fail identically.
   */
  async consumeOtpDeliveries(handle: OtpDeliveryHandler): Promise<void> {
    const channel = this.require();
    await channel.consume(this.otpQueue, async (message) => {
      if (message === null) return;
      let request: OtpDeliveryMessage;
      try {
        request = JSON.parse(message.content.toString()) as OtpDeliveryMessage;
      } catch {
        this.logger.error('dead-lettering an OTP delivery that is not JSON');
        channel.nack(message, false, false);
        return;
      }

      try {
        await handle(request);
        channel.ack(message);
      } catch (err) {
        // The phone number is not logged: a delivery id names the send, and
        // an error line is the wrong place to put a subscriber's number.
        this.logger.error(
          `OTP delivery ${request.deliveryId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        channel.nack(message, false, false);
      }
    });
  }

  /**
   * Start consuming bot updates — **one consumer per queue, each on its own
   * channel at `prefetch: 1`** (F-067-b).
   *
   * The channel per queue is the load-bearing part and it is easy to get
   * wrong: `prefetch` is a **channel** setting, not a consumer setting, so
   * every one of these on the shared channel would share one budget of
   * `AUTOMATION_PREFETCH` unacked messages — updates from different chats
   * would then run at once on that channel while a busy chat starved the rest,
   * and the ordering the routing key was chosen to give would be gone.
   * A channel each, at one message each, is what makes "one chat, one queue,
   * one message at a time" true.
   *
   * The rules are the tick queue's otherwise: acked after the handler returns,
   * so a process killed mid-flow leaves the update for the next replica;
   * nacked without requeue on a failure, so it dead-letters (F-067-d) instead
   * of spinning. An update is not a tick — it does not recur — which is
   * exactly why that path had to exist before this row could be built.
   */
  async consumeBotUpdates(handle: BotUpdateHandler): Promise<void> {
    const connection = this.connection;
    if (!connection) throw new Error('broker connection is not open');

    for (let slot = 0; slot < this.botUpdateQueues; slot++) {
      const queue = botUpdateQueueName(this.botUpdatePrefix, slot);
      const channel = await connection.createChannel();
      await channel.prefetch(1);
      this.botUpdateChannels.push(channel);

      await channel.consume(queue, async (message) => {
        if (message === null) return;
        let update: BotUpdateMessage;
        try {
          update = JSON.parse(message.content.toString()) as BotUpdateMessage;
        } catch {
          this.logger.error(`dead-lettering a bot update that is not JSON`);
          channel.nack(message, false, false);
          return;
        }

        try {
          await handle(update);
          channel.ack(message);
        } catch (err) {
          // The chat id and not the body: a bot update is a person's message,
          // and an error line is the wrong place to keep one.
          this.logger.error(
            `bot update for chat ${update.chatId ?? 'unknown'} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          channel.nack(message, false, false);
        }
      });
    }

    this.logger.log(
      `consuming bot updates from ${this.botUpdateQueues} queue(s)`,
    );
  }

  /**
   * Start draining the dead-letter queue.
   *
   * The handler is expected to make the message durable somewhere else before
   * it returns; a handler that throws leaves the message on this queue
   * (`requeue: true`), because the queue is the only remaining copy of it. That
   * is the opposite of the main queue's rule on purpose: there, a message that
   * keeps failing has somewhere to go, and here it does not.
   */
  async consumeDeadLetters(handle: DeadLetterHandler): Promise<void> {
    const channel = this.require();
    await channel.consume(this.deadQueue, async (message) => {
      if (message === null) return;
      try {
        await handle({
          routingKey: message.fields.routingKey,
          content: message.content,
          headers: (message.properties.headers ?? {}) as Record<string, unknown>,
        });
        channel.ack(message);
      } catch (err) {
        this.logger.error(
          `could not record a dead-lettered message — leaving it on ${this.deadQueue}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        channel.nack(message, false, true);
      }
    });
  }

  async onApplicationShutdown() {
    for (const channel of this.botUpdateChannels) {
      await channel.close().catch((): void => undefined);
    }
    await this.channel?.close().catch((): void => undefined);
    await this.connection?.close().catch((): void => undefined);
  }

  private require(): amqp.ConfirmChannel {
    if (!this.channel) throw new Error('broker channel is not open');
    return this.channel;
  }
}
