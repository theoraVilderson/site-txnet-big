import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { PackageProductsService } from './package-products.service';
import { PackageProductsController, ResellerLimitsController, ResellerLimitsOfController } from './reseller-limits.controller';
import { ResellerLimitsService } from './reseller-limits.service';

/**
 * Reseller limits at three levels (F-019-m, ADR-0106): the platform owner's
 * table and its writes, and one reseller's limits with what it has used (F-019-s). Enforcement lives where each limit is spent; this
 * module only sets the numbers — and which platform products a package sells (F-019-v5). Both Prisma pools come from the global `PrismaModule`.
 */
@Module({
  controllers: [ResellerLimitsController, ResellerLimitsOfController, PackageProductsController],
  providers: [ResellerLimitsService, PackageProductsService, ResellerAccess],
})
export class LimitsModule {}
