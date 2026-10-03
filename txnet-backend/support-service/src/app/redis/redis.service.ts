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
 * `support-service`'s Redis: the rate limiter's counters, the tenant status
 * key `TenantStatusGuard` reads, and live conversations' proofs and events (F-034). Keys are built by callers
 * through `RedisKeys` (C-03); the prefix is the platform's keyspace.
 */
@Injectable()
export class RedisService implements RateLimitStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  /** Applied by ioredis to keys only; a pub/sub channel takes it by hand (F-067-i). */
  readonly keyPrefix: string;

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

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /** `SET key value EX ttl`. */
  async set(key: string, value: string, ttlSec: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSec);
  }

  /** `SET key value NX EX ttl` — true when this call wrote it. */
  async setNx(key: string, value: string, ttlSec: number): Promise<boolean> {
    return (await this.client.set(key, value, 'EX', ttlSec, 'NX')) === 'OK';
  }

  async expire(key: string, ttlSec: number): Promise<void> {
    await this.client.expire(key, ttlSec);
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.client.zadd(key, score, member);
  }

  async zrem(key: string, member: string): Promise<void> {
    await this.client.zrem(key, member);
  }

  /** Members scored above `min`. */
  zrangebyscore(key: string, min: number): Promise<string[]> {
    return this.client.zrangebyscore(key, `(${min}`, '+inf');
  }

  /** Drops members scored at or below `max`. */
  async zremrangebyscore(key: string, max: number): Promise<void> {
    await this.client.zremrangebyscore(key, '-inf', max);
  }

  /** `channel` is a full wire name — the caller applies `keyPrefix`. */
  publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }
}
