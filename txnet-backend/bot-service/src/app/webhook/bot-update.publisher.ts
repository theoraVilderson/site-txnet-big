import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import {
  PublishNotConfirmedError,
  botUpdateRoutingKey,
  confirmedPublisher,
  type ConfirmedPublish,
} from '@txnet-backend/shared-core';
import { BotPlatform } from '@txnet-backend/messenger';
import { ChatContext } from '../conversation/nav.types';

/**
 * What rides the queue in place of a conversation (F-067-b).
 *
 * It is a {@link ChatContext} with the **integration taken off it and the
 * webhook path put on instead**. That swap is the whole security content of
 * this feature. A `BotIntegration` carries `tenantId` and `credentialRef`, and
 * putting it on a queue would mean a tenancy decision travelling as data
 * through a broker, to be trusted on the way out by whoever reads it — which
 * is the thing `webhook.controller.ts` refuses to do with a request body.
 * Carrying the path means the consumer's side resolves the tenant the same way
 * the front door did, from the one value that is a lookup key and not a claim.
 */
export interface BotUpdateMessage {
  platform: BotPlatform;
  /** Resolved back to the integration — and so to the tenant — on arrival. */
  webhookPath: string;
  chatId: string;
  senderId?: string | number;
  lang: string;
  text?: string;
  contact?: ChatContext['contact'];
  callbackData?: string;
  callbackQueryId?: string;
  messageId?: number;
}

/**
 * This service's one connection to the broker, and the only place in
 * `bot-service` that knows RabbitMQ exists.
 *
 * **`RABBITMQ_URL` is required here, unlike in `auth-service`.** That process
 * makes the broker optional because it has logins to serve either way, and a
 * publish is one route of many. This one serves exactly one route, and that
 * route's entire job is now to enqueue: a `bot-service` that cannot reach the
 * broker cannot do anything at all, so it should fail at boot rather than
 * answer every update with a 503 that Telegram will keep retrying into.
 *
 * The connection is still opened lazily and dropped on error rather than
 * killing the process: an update that arrives during a broker restart is a
 * 5xx, and a 5xx is a redelivery. `worker-service` exits on a broker loss
 * because it has nothing else to do; this one has a redelivery contract.
 */
@Injectable()
export class BotUpdatePublisher implements OnApplicationShutdown {
  private readonly logger = new Logger(BotUpdatePublisher.name);
  private readonly url: string;
  private readonly exchange: string;
  private readonly queues: number;
  private readonly confirmMs: number;

  private connection?: amqp.ChannelModel;
  private channel?: amqp.ConfirmChannel;
  private publisher?: ConfirmedPublish;
  /** In flight, so two updates at once open one channel. */
  private connecting?: Promise<ConfirmedPublish>;

  constructor(config: ConfigService) {
    this.url = config.getOrThrow<string>('RABBITMQ_URL');
    this.exchange = config.getOrThrow<string>('AUTOMATION_EXCHANGE');
    this.queues = config.getOrThrow<number>('BOT_UPDATE_QUEUES');
    this.confirmMs = config.getOrThrow<number>('AUTOMATION_PUBLISH_CONFIRM_MS');
  }

  /**
   * Put one update on the queue its chat belongs to.
   *
   * Throws `ServiceUnavailableException` when the broker did not confirm it,
   * which the webhook route lets escape as a 5xx **on purpose** (D-18, and the
   * contract note in `interfaces/bot-app/contract.webhook.md`): the platform
   * redelivers what it was not told was handled, and a redelivery is the only
   * recovery this path has until F-067-c gives it a durable store.
   */
  async publish(update: BotUpdateMessage): Promise<void> {
    const publish = await this.open();
    const routingKey = botUpdateRoutingKey(update.chatId, this.queues);
    try {
      await publish(
        this.exchange,
        routingKey,
        Buffer.from(JSON.stringify(update)),
        { persistent: true, contentType: 'application/json' },
      );
    } catch (err) {
      if (err instanceof PublishNotConfirmedError) {
        // `unroutable` here means `worker-service` has never asserted the
        // queue set — an operator's problem, and one a confirm alone would
        // have called a success (F-067-f).
        this.logger.error(
          `${routingKey} was not confirmed (${err.reason}): ${err.message}`,
        );
        throw new ServiceUnavailableException('the update was not queued');
      }
      throw err;
    }
  }

  private async open(): Promise<ConfirmedPublish> {
    if (this.publisher) return this.publisher;
    if (!this.connecting) this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(): Promise<ConfirmedPublish> {
    try {
      const connection = await amqp.connect(this.url);
      const channel = await connection.createConfirmChannel();
      // Asserted rather than assumed: this process may reach the broker before
      // `worker-service` ever has, and AMQP drops a publish to an exchange
      // that does not exist instead of refusing it. The queues themselves are
      // the consumer's to declare — a producer that asserted them would be
      // deciding the consumer's parallelism from the wrong side.
      await channel.assertExchange(this.exchange, 'topic', { durable: true });

      const forget = () => {
        this.connection = undefined;
        this.channel = undefined;
        this.publisher = undefined;
      };
      connection.on('close', forget);
      connection.on('error', (err: Error) => {
        this.logger.error(`broker connection error: ${err.message}`);
        forget();
      });

      const publish = confirmedPublisher(channel, this.confirmMs);
      this.connection = connection;
      this.channel = channel;
      this.publisher = publish;
      return publish;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`could not reach the broker: ${message}`);
      throw new ServiceUnavailableException('the update was not queued');
    }
  }

  async onApplicationShutdown() {
    await this.channel?.close().catch((): void => undefined);
    await this.connection?.close().catch((): void => undefined);
  }
}
