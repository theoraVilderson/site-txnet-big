import { Global, Module } from '@nestjs/common';
import { RATE_LIMIT_STORE, RateLimiter } from '@txnet-backend/shared-core';

import { RedisService } from './redis.service';

/**
 * Redis and the rate limiter it counts for (F-092-r). The guard that uses it
 * is registered in `app.module.ts`.
 */
@Global()
@Module({
  providers: [
    RedisService,
    { provide: RATE_LIMIT_STORE, useExisting: RedisService },
    RateLimiter,
  ],
  exports: [RedisService, RateLimiter],
})
export class RedisModule {}
