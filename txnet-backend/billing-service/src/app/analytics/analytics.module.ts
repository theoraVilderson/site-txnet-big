import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { AnalyticsInternalController } from './analytics-internal.controller';
import { AnalyticsRollupService } from './analytics-rollup.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Analytics (F-1001): the rollup every figure is read from and the worker that
 * rebuilds it (F-1001-a), and the tabs that read it (F-1001-b). `PrismaModule`
 * is `@Global()` and binds `RESELLER_ACCESS_READER` beside it.
 */
@Module({
  controllers: [AnalyticsController, AnalyticsInternalController],
  providers: [AnalyticsRollupService, AnalyticsService, ResellerAccess],
  exports: [AnalyticsRollupService],
})
export class AnalyticsModule {}
