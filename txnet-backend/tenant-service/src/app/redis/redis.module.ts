import { Global, Module } from '@nestjs/common';
import { RATE_LIMIT_STORE, RateLimiter, TENANT_STATUS_STORE } from '@txnet-backend/shared-core';

import { RedisService } from './redis.service';

/**
 * Redis and the rate limiter it counts for (F-092-r). The guard that uses it
 * is registered in `app.module.ts`, beside `TenantStatusGuard`, which reads
 * the tenant status key through the same client (F-018-p).
 */
@Global()
@Module({
  providers: [
    RedisService,
    { provide: RATE_LIMIT_STORE, useExisting: RedisService },
    { provide: TENANT_STATUS_STORE, useExisting: RedisService },
    RateLimiter,
  ],
  exports: [RedisService, RateLimiter, TENANT_STATUS_STORE],
})
export class RedisModule {}
