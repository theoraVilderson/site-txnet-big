import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildRedisKeyPrefix, type TenantStatusStore } from '@txnet-backend/shared-core';
import Redis from 'ioredis';

import type { EnvConfig } from '../config/env.validation';

/**
 * Redis under the platform's keyspace prefix (ADR-0005). Today it serves the
 * tenant status key `TenantStatusGuard` reads (C-11) and the platform's
 * silence switch (F-1548); the profile builder's reads (F-038-c) come through
 * here too.
 */
@Injectable()
export class RedisService implements TenantStatusStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      keyPrefix: buildRedisKeyPrefix(
        config.get('REDIS_KEY_NAMESPACE', { infer: true }),
        config.get('REDIS_KEYSPACE_VERSION', { infer: true }),
      ),
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    this.client.on('error', (err) => this.logger.error(`redis client error: ${err.message}`));
  }

  async onModuleInit() {
    await this.client.connect();
  }

  async onModuleDestroy() {
    await this.client.quit().catch((): void => undefined);
  }

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  mget(...keys: string[]): Promise<Array<string | null>> {
    return this.client.mget(...keys);
  }

  /** `value` under `key`, expiring after `ms`. */
  async setFor(key: string, value: string, ms: number): Promise<void> {
    await this.client.set(key, value, 'PX', ms);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}
