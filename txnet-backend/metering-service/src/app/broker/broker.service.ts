import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import {
  inMessageScope,
  NETWORK_USAGE_ROUTING_PREFIX,
  OutboxEventType,
  outboxRoutingKey,
  startHeartbeat,
  topicBindingAll,
  type UsageDeltaMessage,
  usageDeltaMessageSchema,
  type UsageEvent,
  usageEventMessageSchema,
  usageReleaseMessageSchema,
  type UsageReleasePayload,
  userSignedUpMessageSchema,
  type UserSignedUpPayload,
} from '@txnet-backend/shared-core';
import type { z } from 'zod';

export type UsageDeltaHandler = (message: UsageDeltaMessage) => Promise<void>;
export type UsageReleaseHandler = (release: UsageReleasePayload) => Promise<void>;
export type UsageEventHandler = (event: UsageEvent) => Promise<void>;
export type SignupHandler = (signup: UserSignedUpPayload) => Promise<void>;

/** What each message on the metering queue is handed to. */
export type UsageHandlers = { delta: UsageDeltaHandler; release: UsageReleaseHandler; usage: UsageEventHandler; signup: SignupHandler };

/** Where a released hold arrives from: `billing-service`'s outbox (F-027-at, ADR-0080 decision 3). */
const USAGE_RELEASE_KEY = outboxRoutingKey(OutboxEventType.USAGE_RELEASE);

/** Where a reported use of a non-VPN meter arrives from: any service's outbox (F-118-f, ADR-0105 decision 5). */
const USAGE_EVENT_KEY = outboxRoutingKey(OutboxEventType.USAGE_EVENT);

/** Where a signup arrives from: identity's outbox, for analytics (F-1001-f). Rare, so it shares this queue. */
const USER_SIGNED_UP_KEY = outboxRoutingKey(OutboxEventType.USER_SIGNED_UP);

/**
 * The RabbitMQ connection, and the only place in this service that knows the
 * broker exists (ADR-0027, ADR-0077).
 *
 * **Topology.** The automation exchange every message on this platform rides,
 * and one durable queue on it bound to `network.usage.#` — the prefix
 * `contracts/network/delta.json` declares and `network-service` publishes
 * under — and to `outbox.network.usage.release`, the released holds
 * `billing-service` queues through its outbox (F-027-at), to
 * `outbox.billing.usage.event`, a reported use of any other meter (F-118-f),
 * and to `outbox.identity.user.signed_up`, a signup for analytics (F-1001-f). Its own queue, not a share of the tick queue: a collection pass is a
 * different rate and a different depth to alert on, and a backlog of usage must
 * never sit in front of an OTP.
 *
 * **Acknowledgement is manual and late**, so a process killed mid-pass leaves
 * the message unacked and the broker redelivers it. That is at-least-once, and
 * it is what `usage_delta_seen` turns into an exactly-once effect (F-027-n) —
 * the queue guarantees nothing of the kind and is not asked to.
 *
 * **A failed handler is nacked without requeue**, onto the dead-letter
 * exchange (F-067-d): a permanently failing pass requeued at the speed of the
 * broker is how one bad panel becomes an outage of the whole pipeline. Nothing
 * is lost by that rejection — the collector's cursor only moves on a successful
 * publish, so the same bytes are read again on the next pass — but the message
 * itself is kept, because a dead-lettered pass is the evidence of what arrived.
 *
 * **The body is validated here, against the fixture's schema.** A message that
 * does not parse cannot be made to parse by redelivery, so it dead-letters
 * immediately rather than occupying a consumer.
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
  private readonly deadExchange: string;

  /** Set when this service closes the connection itself, so its `close` is not read as the broker's. */
  private stopping = false;

  constructor(config: ConfigService) {
    this.url = config.getOrThrow<string>('RABBITMQ_URL');
    this.exchange = config.getOrThrow<string>('AUTOMATION_EXCHANGE');
    this.queue = config.getOrThrow<string>('METERING_QUEUE');
    this.prefetch = config.getOrThrow<number>('METERING_PREFETCH');
    this.deadExchange = config.getOrThrow<string>('AUTOMATION_DLX');
  }

  async onModuleInit() {
    this.connection = await amqp.connect(this.url);
    this.channel = await this.connection.createChannel();

    await this.channel.assertExchange(this.exchange, 'topic', { durable: true });
    // Declared, not assumed: this service may boot before worker-service does,
    // and a queue naming a dead-letter exchange that does not exist yet drops
    // what it rejects.
    await this.channel.assertExchange(this.deadExchange, 'topic', { durable: true });
    await this.channel.assertQueue(this.queue, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': this.deadExchange },
    });
    await this.channel.bindQueue(this.queue, this.exchange, topicBindingAll(NETWORK_USAGE_ROUTING_PREFIX));
    await this.channel.bindQueue(this.queue, this.exchange, USAGE_RELEASE_KEY);
    await this.channel.bindQueue(this.queue, this.exchange, USAGE_EVENT_KEY);
    await this.channel.bindQueue(this.queue, this.exchange, USER_SIGNED_UP_KEY);
    await this.channel.prefetch(this.prefetch);
    startHeartbeat(this.channel);

    // A dropped connection is fatal rather than retried, for the reason
    // worker-service's class gives: a half-connected consumer that logs an
    // error every few seconds while consuming nothing is the failure that
    // hides itself, and here it hides as usage that stopped being recorded.
    this.connection.on('error', (err: Error) => this.logger.error(`broker connection error: ${err.message}`));
    this.connection.on('close', () => {
      // Our own close (a deploy, a dev reload) is not the broker going away.
      if (this.stopping) return;
      this.logger.error('broker connection closed — exiting');
      process.exit(1);
    });

    this.logger.log(
      `connected to broker; exchange=${this.exchange} queue=${this.queue} ` +
        `binding=${topicBindingAll(NETWORK_USAGE_ROUTING_PREFIX)},${USAGE_RELEASE_KEY},${USAGE_EVENT_KEY},${USER_SIGNED_UP_KEY} prefetch=${this.prefetch} dlx=${this.deadExchange}`,
    );
  }

  /** Start consuming: collection passes, released holds, usage events and signups, each to its handler by routing key. */
  async consumeUsage(handlers: UsageHandlers): Promise<void> {
    const channel = this.require();
    await channel.consume(this.queue, inMessageScope(async (message) => {
      if (message === null) return;
      const key = message.fields.routingKey;
      if (key === USAGE_EVENT_KEY) {
        await this.settle(message, usageEventMessageSchema, (m) => handlers.usage(m.payload), (m) => `usage event ${m.payload.source}/${m.payload.idempotencyKey}`);
      } else if (key === USAGE_RELEASE_KEY) {
        await this.settle(message, usageReleaseMessageSchema, (m) => handlers.release(m.payload), (m) => `usage release of hold ${m.payload.holdId}`);
      } else if (key === USER_SIGNED_UP_KEY) {
        await this.settle(message, userSignedUpMessageSchema, (m) => handlers.signup(m.payload), (m) => `signup of user ${m.payload.userId}`);
      } else {
        await this.settle(message, usageDeltaMessageSchema, (m) => handlers.delta(m), (m) => `usage delta pass over panel ${m.panelId}`);
      }
    }));
    this.logger.log(`consuming usage deltas from ${this.queue}`);
  }

  async onApplicationShutdown() {
    this.stopping = true;
    await this.channel?.close().catch((): void => undefined);
    await this.connection?.close().catch((): void => undefined);
  }

  /**
   * One message: parsed against its schema, handled, acked — or nacked without
   * requeue onto the dead-letter exchange, when it does not parse (redelivery
   * cannot make it) or its handler throws (the class comment's rule).
   */
  private async settle<T>(message: amqp.ConsumeMessage, schema: z.ZodType<T, z.ZodTypeDef, unknown>, handle: (m: T) => Promise<void>, what: (m: T) => string): Promise<void> {
    const channel = this.require();
    const parsed = schema.safeParse(safeJson(message.content));
    if (!parsed.success) {
      this.logger.error(`dead-lettering a ${message.fields.routingKey} message that is not valid: ${parsed.error.message}`);
      channel.nack(message, false, false);
      return;
    }
    try {
      await handle(parsed.data);
      channel.ack(message);
    } catch (err) {
      this.logger.error(`${what(parsed.data)} failed: ${err instanceof Error ? err.message : String(err)}`);
      channel.nack(message, false, false);
    }
  }

  private require(): amqp.Channel {
    if (!this.channel) throw new Error('broker channel is not open');
    return this.channel;
  }
}

/** `undefined` rather than a throw: the schema below reports both failures the same way. */
function safeJson(content: Buffer): unknown {
  try {
    return JSON.parse(content.toString());
  } catch {
    return undefined;
  }
}
