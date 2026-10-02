import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { TenantTimeZoneController } from './tenant-time-zone.controller';
import { TenantTimeZoneService } from './tenant-time-zone.service';

/**
 * A tenant's time zone (TZ-1-d, ADR-0108 point 7), on `tenant.tenant.timezone`.
 *
 * `PrismaModule` is `@Global`, so it is not imported here.
 */
@Module({
  controllers: [TenantTimeZoneController],
  providers: [TenantTimeZoneService, ResellerAccess],
})
export class TenantTimeZoneModule {}
