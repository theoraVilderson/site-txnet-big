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
  confirmedPublisher,
  type ConfirmedPublish,
} from '@txnet-backend/shared-core';

/**
 * This process's one connection to the broker, and the only place in
 * `auth-service` that knows RabbitMQ exists.
 *
 * ADR-0027 moved background *work* out of `auth-service`; none of that argument
 * is about publishing. A message is a frame on an open channel, and the
 * alternative — running the work here — is precisely what the ADR forbids.
 *
 * **The connection is lazy, and its absence is not a boot failure.** This is
 * the process that answers `/auth/login`, so `RABBITMQ_URL` is optional, the
 * connection opens on the first publish, and a broker that cannot be reached
 * fails that one route with a 503 — the shape the Credential Vault takes when
 * `VAULT_KEK_FILE` is unset (ADR-0026).
 *
 * **A publish the broker did not confirm fails the caller the same way**
 * (F-067-f, D-18). Accept-and-reconcile needs the durable store F-067-c
 * builds; until it exists, retrying is the whole recovery path. Publishing
 * `mandatory` matters more here than in `worker-service`: this process asserts
 * the exchange but never a queue, so before `worker-service` has ever booted
 * there is nothing bound to receive anything, and a confirm alone would call
 * that a success.
 *
 * It was extracted from `ManualTickPublisher` by F-067-a, which made OTP
 * delivery the second publisher in this process. Two lazy connections to the
 * same broker from the same service is a bug waiting for the day one of them
 * reconnects and the other does not.
 */
@Injectable()
export class AuthBrokerPublisher implements OnApplicationShutdown {
  private readonly logger = new Logger(AuthBrokerPublisher.name);
  private readonly url: string | undefined;
  readonly exchange: string;
  private readonly confirmMs: number;

  private connection?: amqp.ChannelModel;
  private channel?: amqp.ConfirmChannel;
  private publisher?: ConfirmedPublish;
  /** In flight, so two callers at once open one channel. */
  private connecting?: Promise<ConfirmedPublish>;

  constructor(config: ConfigService) {
    this.url = config.get<string>('RABBITMQ_URL');
    this.exchange = config.getOrThrow<string>('AUTOMATION_EXCHANGE');
    this.confirmMs = config.getOrThrow<number>('AUTOMATION_PUBLISH_CONFIRM_MS');
  }

  /**
   * Publish one JSON message, awaited to the broker's confirm.
   *
   * `unavailable` is the message a caller's 503 carries. It is the caller's
   * because only the caller knows what did not happen — "the run request" reads
   * differently from "the code" to whoever sees it.
   */
  async publishJson(
    routingKey: string,
    body: unknown,
    unavailable: string,
  ): Promise<void> {
    const publish = await this.open(unavailable);
    try {
      await publish(
        this.exchange,
        routingKey,
        Buffer.from(JSON.stringify(body)),
        { persistent: true, contentType: 'application/json' },
      );
    } catch (err) {
      if (err instanceof PublishNotConfirmedError) {
        // The reason is logged and not returned: `unroutable` means nobody has
        // deployed a consumer, which is an operator's problem, and either way
        // the answer to the caller is the same one — it did not happen.
        this.logger.error(
          `${routingKey} was not confirmed (${err.reason}): ${err.message}`,
        );
        throw new ServiceUnavailableException(unavailable);
      }
      throw err;
    }
    this.logger.log(`published ${routingKey}`);
  }

  private async open(unavailable: string): Promise<ConfirmedPublish> {
    if (this.publisher) return this.publisher;
    if (!this.url)
      throw new ServiceUnavailableException(
        'RABBITMQ_URL is not set — this deployment cannot publish',
      );
    if (!this.connecting) this.connecting = this.connect(this.url, unavailable);
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(
    url: string,
    unavailable: string,
  ): Promise<ConfirmedPublish> {
    try {
      const connection = await amqp.connect(url);
      const channel = await connection.createConfirmChannel();
      // Asserted, not assumed: this process may reach the broker before
      // `worker-service` ever has, and a publish to an exchange that does not
      // exist is silently dropped by AMQP rather than refused.
      await channel.assertExchange(this.exchange, 'topic', { durable: true });

      // A dropped connection clears the handles rather than killing the
      // process. `worker-service` exits on a broker loss because it has
      // nothing else to do; this one has logins to serve, and the next publish
      // simply reconnects.
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
      throw new ServiceUnavailableException(unavailable);
    }
  }

  async onApplicationShutdown() {
    await this.channel?.close().catch((): void => undefined);
    await this.connection?.close().catch((): void => undefined);
  }
}
