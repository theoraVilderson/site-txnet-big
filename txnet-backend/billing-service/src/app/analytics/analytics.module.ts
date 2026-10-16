import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { LocaleModule } from '../locale/locale.module';
import { AnalyticsExportService } from './analytics-export.service';
import { AnalyticsInternalController } from './analytics-internal.controller';
import { AnalyticsRollupService } from './analytics-rollup.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Analytics (F-1001): the rollup every figure is read from and the worker that
 * rebuilds it (F-1001-a), the tabs that read it (F-1001-b) and their files
 * (F-1007-a, `LocaleModule` for the reader's words). `PrismaModule`
 * is `@Global()` and binds `RESELLER_ACCESS_READER` beside it.
 */
@Module({
  imports: [LocaleModule],
  controllers: [AnalyticsController, AnalyticsInternalController],
  providers: [AnalyticsRollupService, AnalyticsService, AnalyticsExportService, ResellerAccess],
  exports: [AnalyticsRollupService],
})
export class AnalyticsModule {}
