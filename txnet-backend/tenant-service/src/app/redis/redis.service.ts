import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimitStore, buildRedisKeyPrefix } from '@txnet-backend/shared-core';
import Redis from 'ioredis';

import type { EnvConfig } from '../config/env.validation';

const INCR_WITH_TTL = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

/**
 * `tenant-service`'s Redis: the rate limiter's counters, the tenant status key,
 * and deleting a new reseller's `tenant:host:*` entry (F-092-r, D-24, F-018-p,
 * F-018-y) — nothing else. Under the platform's one keyspace prefix, so a
 * `REDIS_KEYSPACE_VERSION` bump abandons these keys with every other
 * (ADR-0005). Keys are built by `shared-core`'s `RateLimiter`, never here
 * (C-03).
 */
@Injectable()
export class RedisService implements RateLimitStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private readonly keyPrefix: string;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.keyPrefix = buildRedisKeyPrefix(
      config.get('REDIS_KEY_NAMESPACE', { infer: true }),
      config.get('REDIS_KEYSPACE_VERSION', { infer: true }),
    );
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      keyPrefix: this.keyPrefix,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    // Without a listener Node treats a connection error as uncaught and kills
    // the process — every tenant route with it, not only the limited ones.
    this.client.on('error', (err) => this.logger.error(`redis client error: ${err.message}`));
  }

  async onModuleInit() {
    await this.client.connect();
    this.logger.log(`connected to redis (keyspace "${this.keyPrefix}")`);
  }

  onModuleDestroy() {
    this.client.disconnect();
  }

  incrementWithTtl(key: string, ttlSec: number): Promise<number> {
    return this.client.eval(INCR_WITH_TTL, 1, key, ttlSec) as Promise<number>;
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /** One read, for `TenantStatusGuard`'s `tenant:status:<id>` (F-018-p); the key is built by the caller. */
  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /**
   * One write, no TTL: `TenantStatusListener` owns `tenant:status:<id>` and
   * rewrites it on every change and on each connect (F-018-w). A TTL would let
   * the key expire into "unknown", which refuses nobody — every service would
   * stop enforcing a suspension until the next notification.
   */
  async set(key: string, value: string): Promise<void> {
    await this.client.set(key, value);
  }

  /**
   * One pub/sub message, never thrown: the key it announces is already written,
   * and `gateway-service`'s re-check tick reads that key anyway (F-018-r). The
   * prefix by hand: ioredis applies `keyPrefix` to keys, and a channel is not
   * one — unprefixed, the message reaches nobody and reports success.
   */
  async publish(channel: string, body: string): Promise<void> {
    try {
      await this.client.publish(`${this.keyPrefix}${channel}`, body);
    } catch (err) {
      this.logger.error(`could not publish on ${channel}: ${(err as Error).message}`);
    }
  }
}
