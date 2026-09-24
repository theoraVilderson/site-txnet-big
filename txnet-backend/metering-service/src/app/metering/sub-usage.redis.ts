import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildRedisKeyPrefix } from '@txnet-backend/shared-core';
import Redis from 'ioredis';

import type { EnvConfig } from '../config/env.validation';

/**
 * `metering-service`'s Redis connection, held for one key family: `sub:usage:`
 * (F-609-a). Under the platform's one keyspace prefix (ADR-0005), so
 * `sub-service` reads what this writes.
 *
 * **Built to fail fast, never to wait.** No offline queue and no per-command
 * retry: while Redis is down a write fails at once and the delta goes on
 * without it, instead of a pass sitting on a command queue that holds its ack.
 * The connection is not awaited at boot for the same reason — a process whose
 * job is money does not refuse to start over a usage bar. ioredis reconnects
 * on its own.
 */
@Injectable()
export class SubUsageRedis implements OnModuleDestroy {
  private readonly logger = new Logger(SubUsageRedis.name);
  readonly client: Redis;

  constructor(config: ConfigService<EnvConfig, true>) {
    const keyPrefix = buildRedisKeyPrefix(
      config.get('REDIS_KEY_NAMESPACE', { infer: true }),
      config.get('REDIS_KEYSPACE_VERSION', { infer: true }),
    );
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      keyPrefix,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    // Without a listener Node treats a connection error as uncaught and kills
    // the process, and every pass with it.
    this.client.on('error', (err) => this.logger.warn(`redis client error: ${err.message}`));
  }

  onModuleDestroy() {
    this.client.disconnect();
  }
}
