import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { TenantAccessController } from './tenant-access.controller';
import { TenantAccessService } from './tenant-access.service';

/**
 * The door's own verdict as a surface (F-311-e), for a screen deciding whether
 * to offer itself. `PrismaModule` and `RedisModule` are `@Global`, so neither
 * is imported here.
 */
@Module({
  controllers: [TenantAccessController],
  providers: [TenantAccessService, ResellerAccess],
})
export class AccessModule {}
