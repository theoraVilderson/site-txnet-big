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
 * The same keyspace `auth-service` and `bot-service` write, under the same
 * prefix: one `REDIS_KEYSPACE_VERSION` bump must abandon every key this
 * platform holds (ADR-0005). Keys are built in `redis.keys.ts` and nowhere
 * else (C-03).
 *
 * This is the fourth thing `worker-service` depends on, and F-067-e is what
 * added it. `env.validation.ts` says why the process would rather not have it
 * and why it has it anyway: a per-tenant cap counted in process memory means
 * one budget per replica, which is not a cap at the scale it exists for.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  public readonly client: Redis;
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
    // which for this deployable means the queue stops draining entirely.
    this.client.on('error', (err) =>
      this.logger.error(`redis client error: ${err.message}`),
    );
  }

  async onModuleInit() {
    await this.client.connect();
    this.logger.log(`connected to redis (keyspace "${this.keyPrefix}")`);
  }

  onModuleDestroy() {
    this.client.disconnect();
  }

  /**
   * Remove one member from a sorted set. The whole of a lease being handed
   * back (`TenantRunLeases.release`).
   */
  async zrem(key: string, member: string): Promise<void> {
    await this.client.zrem(key, member);
  }

  /** Members of a sorted set whose score is above `min` — leases still live. */
  zcount(key: string, min: number): Promise<number> {
    return this.client.zcount(key, `(${min}`, '+inf');
  }

  /**
   * Publish one message on a pub/sub channel (F-067-i).
   *
   * `channel` is the **full wire name, prefix included** — the caller built
   * it, because ioredis will not: `keyPrefix` is applied to key arguments and
   * a pub/sub channel is not a key. Nothing else in this service is written
   * that way, which is exactly why it is spelled out here and at the one call
   * site.
   *
   * The return value is how many subscribers Redis handed it to, and it is
   * deliberately not treated as a failure when it is zero. A realtime event
   * published while nobody is connected is dropped by contract
   * (`realtime/contract.md`); the durable answer, where one exists, belongs
   * to the producing domain, not to the socket.
   */
  publish(channel: string, body: string): Promise<number> {
    return this.client.publish(channel, body);
  }

  evalScript<T = unknown>(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<T> {
    return this.client.eval(script, keys.length, ...keys, ...args) as Promise<T>;
  }
}
