import { Global, Module } from '@nestjs/common';
import { SEND_RATE_STORE } from '@txnet-backend/messenger';
import { RATE_LIMIT_STORE, RateLimiter, TENANT_STATUS_STORE } from '@txnet-backend/shared-core';

import { RedisService } from './redis.service';

/**
 * Redis and the rate limiter it counts for (F-092-r). The guard that uses it
 * is registered in `app.module.ts`, beside `TenantStatusGuard`, which reads
 * the tenant status key through the same client (F-018-p).
 *
 * `SEND_RATE_STORE` is the outbound counterpart (F-313-a, ADR-0066): what this
 * service's campaign sends may spend on a tenant's bot, rather than what it
 * will accept. Every app that sends binds it the same way, in its own
 * `RedisModule` — `messenger` is a library shared by four apps and cannot hold
 * a client of its own.
 */
@Global()
@Module({
  providers: [
    RedisService,
    { provide: RATE_LIMIT_STORE, useExisting: RedisService },
    { provide: TENANT_STATUS_STORE, useExisting: RedisService },
    { provide: SEND_RATE_STORE, useExisting: RedisService },
    RateLimiter,
  ],
  exports: [RedisService, RateLimiter, TENANT_STATUS_STORE, SEND_RATE_STORE],
})
export class RedisModule {}
