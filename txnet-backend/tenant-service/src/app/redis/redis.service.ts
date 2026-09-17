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
 * `tenant-service`'s Redis: the rate limiter's counters and the tenant status key, nothing
 * else (F-092-r, D-24, F-018-p). Under the platform's one keyspace prefix, so a
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

}
