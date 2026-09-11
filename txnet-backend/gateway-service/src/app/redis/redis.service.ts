import {
  REDIS_KEYSPACE_VERSION_DEFAULT,
  REDIS_KEY_NAMESPACE_DEFAULT,
  buildRedisKeyPrefix,
} from '@txnet-backend/shared-core';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * The part of a subscriber connection the fan-out uses (F-067-i).
 *
 * Narrow on purpose: `RealtimeFanout` may subscribe, unsubscribe and hear
 * messages, and it may not run a command — a subscriber connection would
 * refuse one anyway, and stating that in the type is cheaper than discovering
 * it at runtime. It also makes the fan-out testable against a small fake bus
 * instead of a real Redis.
 */
export interface FanoutSubscriberClient {
  on(event: 'message', handler: (channel: string, raw: string) => void): unknown;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
}

/**
 * The same keyspace `auth-service`, `bot-service` and `worker-service` write,
 * under the same prefix: one `REDIS_KEYSPACE_VERSION` bump must abandon every
 * key this platform holds (ADR-0005). Keys are built in `redis.keys.ts` and
 * nowhere else (C-03).
 *
 * `gateway-service` uses Redis for three things: asking whether a session
 * marker still exists (F-067-h), reading the token that authorizes an `otp:`
 * subscription (F-067-j), and hearing the events a producer fanned out to the
 * replica holding a socket (F-067-i). The last needs a connection of its
 * own — see {@link subscriber}. **All three are reads**: nothing in this
 * process writes a key.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  public readonly client: Redis;
  /**
   * The second connection, in subscriber mode (F-067-i).
   *
   * It is a separate client because Redis makes it one: a connection that has
   * issued `SUBSCRIBE` accepts only subscribe/unsubscribe commands until it
   * unsubscribes from everything, so sharing it with the session re-check
   * would break the re-check the moment the first socket subscribed to
   * anything — and break it silently, in the direction that keeps revoked
   * sessions connected. `duplicate()` copies the URL and the options, so the
   * two cannot drift apart in configuration.
   */
  public readonly subscriber: FanoutSubscriberClient & Redis;
  public readonly keyPrefix: string;

  constructor(config: ConfigService) {
    const namespace = config.get<string>(
      'REDIS_KEY_NAMESPACE',
      REDIS_KEY_NAMESPACE_DEFAULT,
    );
    const version = config.get<string>(
      'REDIS_KEYSPACE_VERSION',
      REDIS_KEYSPACE_VERSION_DEFAULT,
    );
    this.keyPrefix = buildRedisKeyPrefix(namespace, version);

    this.client = new Redis(config.get<string>('REDIS_URL')!, {
      keyPrefix: this.keyPrefix,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    // ioredis emits 'error' on every connection failure and retry; with no
    // listener Node treats it as an uncaught exception and kills the process,
    // which for this deployable means every open socket on this replica drops.
    this.client.on('error', (err) =>
      this.logger.error(`redis client error: ${err.message}`),
    );

    this.subscriber = this.client.duplicate() as FanoutSubscriberClient & Redis;
    this.subscriber.on('error', (err) =>
      this.logger.error(`redis subscriber error: ${err.message}`),
    );
  }

  async onModuleInit() {
    await Promise.all([this.client.connect(), this.subscriber.connect()]);
    this.logger.log(`connected to redis (keyspace "${this.keyPrefix}")`);
  }

  onModuleDestroy() {
    this.client.disconnect();
    this.subscriber.disconnect();
  }

  /** Does this key exist? What the session re-check asks. */
  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  /**
   * Read one key, or `null` when it is not there.
   *
   * The second question this service asks, and the only one whose *value*
   * matters: the token that authorizes an `otp:` subscription (F-067-j). Still
   * read-only — this process writes no key, and an expired token is simply an
   * absent one.
   */
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }
}
