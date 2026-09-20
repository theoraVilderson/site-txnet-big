import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { ResellerRevenueController } from './reseller-revenue.controller';
import { ResellerRevenueService } from './reseller-revenue.service';

/**
 * A reseller's own revenue (F-311-b, ADR-0067): one read over the two ledgers
 * that already exist, for the reseller a route names. `PrismaModule` is
 * `@Global()` and binds `RESELLER_ACCESS_READER` to the app pool beside it.
 */
@Module({
  controllers: [ResellerRevenueController],
  providers: [ResellerRevenueService, ResellerAccess],
  exports: [ResellerRevenueService],
})
export class RevenueModule {}
