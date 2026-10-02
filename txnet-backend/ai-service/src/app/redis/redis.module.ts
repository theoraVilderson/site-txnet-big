import { Global, Module } from '@nestjs/common';
import { RATE_LIMIT_STORE, RateLimiter, TENANT_STATUS_STORE } from '@txnet-backend/shared-core';

import { RedisService } from './redis.service';

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
