import { Global, Module } from '@nestjs/common';
import { TENANT_STATUS_STORE, TenantStatusStore } from '@txnet-backend/shared-core';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    RedisService,
    // What `TenantStatusGate` reads a tick's tenant status through (F-018-p).
    {
      provide: TENANT_STATUS_STORE,
      inject: [RedisService],
      useFactory: (redis: RedisService): TenantStatusStore => ({ get: (key) => redis.client.get(key) }),
    },
  ],
  exports: [RedisService, TENANT_STATUS_STORE],
})
export class RedisModule {}
