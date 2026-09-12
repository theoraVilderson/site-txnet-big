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
 * `billing-service`'s Redis: the rate limiter's counters (F-092-r, D-24) and
 * the FX worker's published rate (F-092-c). Under the platform's one keyspace prefix, so a
 * `REDIS_KEYSPACE_VERSION` bump abandons these keys with every other
 * (ADR-0005). Keys are built by `shared-core`'s `RateLimiter`, never here
 * (C-03).
 *
 * Money never lives here: a counter lost with Redis resets a window, it
 * cannot move a balance.
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
    // the process — every billing route with it, not only the limited ones.
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

  /**
   * One read, for the FX worker's published rate (F-092-c). The key is built by
   * `UnscopedRedisKeys.fxRate` and carries the same prefix the worker wrote it
   * under (ADR-0005), so this is a read of that process's key and not a second
   * copy of it. Money still never lives here: the value is a cache of a
   * `currency_exchange_rate` row, and a miss is answered from the table.
   */
  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }
}
