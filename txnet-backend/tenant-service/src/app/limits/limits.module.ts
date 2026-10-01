import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { ResellerLimitsController, ResellerLimitsOfController } from './reseller-limits.controller';
import { ResellerLimitsService } from './reseller-limits.service';

/**
 * Reseller limits at three levels (F-019-m, ADR-0106): the platform owner's
 * table and its writes, and one reseller's limits with what it has used (F-019-s). Enforcement lives where each limit is spent; this
 * module only sets the numbers. Both Prisma pools come from the global `PrismaModule`.
 */
@Module({
  controllers: [ResellerLimitsController, ResellerLimitsOfController],
  providers: [ResellerLimitsService, ResellerAccess],
})
export class LimitsModule {}
