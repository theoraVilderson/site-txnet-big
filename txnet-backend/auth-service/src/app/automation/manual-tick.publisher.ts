import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';

/**
 * The one thing this request-serving process publishes: an `admin_manual` tick
 * (F-031-b, ADR-0027).
 *
 * ADR-0027 moved background work out of `auth-service` because a job running
 * inside a replica that also answers logins degrades logins and runs twice.
 * None of that argument is about *publishing*. A tick is a message the worker
 * acts on; putting one on the exchange costs a frame on an open channel, and
 * the alternative — an admin route that runs the job here — is precisely what
 * the ADR forbids.
 *
 * **The connection is lazy, and its absence is not a boot failure.** This is
 * the process that answers `/auth/login`, and a broker that is down must not
 * be able to stop anyone signing in. So `RABBITMQ_URL` is optional, the
 * connection is opened on the first manual run rather than at boot, and a
 * broker that cannot be reached fails that one route with a 503 — the same
 * shape the Credential Vault takes when `VAULT_KEK_FILE` is unset (ADR-0026).
 */
@Injectable()
export class ManualTickPublisher implements OnApplicationShutdown {
  private readonly logger = new Logger(ManualTickPublisher.name);
  private readonly url: string | undefined;
  private readonly exchange: string;

  private connection?: amqp.ChannelModel;
  private channel?: amqp.Channel;
  /** In flight, so two admins pressing the button at once open one channel. */
  private connecting?: Promise<amqp.Channel>;

  constructor(config: ConfigService) {
    this.url = config.get<string>('RABBITMQ_URL');
    this.exchange = config.getOrThrow<string>('AUTOMATION_EXCHANGE');
  }

  /**
   * Publish one `automation.tick.<key>` with `triggeredBy: 'admin_manual'`.
   *
   * The message shape is `worker-service`'s `TickMessage`, and it is written
   * out here rather than imported: the consumer lives in another Nx app, so
   * the wire between them is the exchange and the four fields on it. That is
   * the seam ADR-0027 chose, and a shared TypeScript type would not make the
   * two processes deploy together anyway.
   */
  async publishManualTick(key: string): Promise<void> {
    const channel = await this.open();
    channel.publish(
      this.exchange,
      `automation.tick.${key}`,
      Buffer.from(
        JSON.stringify({
          key,
          at: new Date().toISOString(),
          reason: 'an admin asked for a run',
          triggeredBy: 'admin_manual',
        }),
      ),
      { persistent: true, contentType: 'application/json' },
    );
    this.logger.log(`published automation.tick.${key} (admin_manual)`);
  }

  private async open(): Promise<amqp.Channel> {
    if (this.channel) return this.channel;
    if (!this.url)
      throw new ServiceUnavailableException(
        'RABBITMQ_URL is not set — this deployment cannot trigger a worker run',
      );
    if (!this.connecting) this.connecting = this.connect(this.url);
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(url: string): Promise<amqp.Channel> {
    try {
      const connection = await amqp.connect(url);
      const channel = await connection.createChannel();
      // Asserted, not assumed: this process may reach the broker before
      // `worker-service` ever has, and a publish to an exchange that does not
      // exist is silently dropped by AMQP rather than refused.
      await channel.assertExchange(this.exchange, 'topic', { durable: true });

      // A dropped connection clears the handles rather than killing the
      // process. `worker-service` exits on a broker loss because it has
      // nothing else to do; this one has logins to serve, and the next manual
      // run simply reconnects.
      const forget = () => {
        this.connection = undefined;
        this.channel = undefined;
      };
      connection.on('close', forget);
      connection.on('error', (err: Error) => {
        this.logger.error(`broker connection error: ${err.message}`);
        forget();
      });

      this.connection = connection;
      this.channel = channel;
      return channel;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`could not reach the broker: ${message}`);
      throw new ServiceUnavailableException('the broker is not reachable');
    }
  }

  async onApplicationShutdown() {
    await this.channel?.close().catch((): void => undefined);
    await this.connection?.close().catch((): void => undefined);
  }
}
