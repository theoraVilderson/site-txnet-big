import { Global, Module } from '@nestjs/common';
import { TENANT_STATUS_STORE } from '@txnet-backend/shared-core';

import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, { provide: TENANT_STATUS_STORE, useExisting: RedisService }],
  exports: [RedisService, TENANT_STATUS_STORE],
})
export class RedisModule {}
