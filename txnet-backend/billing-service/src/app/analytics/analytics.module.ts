import { Module } from '@nestjs/common';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { LocaleModule } from '../locale/locale.module';
import { AnalyticsExportService } from './analytics-export.service';
import { AnalyticsInternalController } from './analytics-internal.controller';
import { AnalyticsLossService } from './analytics-loss.service';
import { AnalyticsReportSender } from './analytics-report-sender';
import { AnalyticsReportsController } from './analytics-reports.controller';
import { AnalyticsReportService } from './analytics-reports.service';
import { AnalyticsRollupService } from './analytics-rollup.service';
import { AnalyticsSettingsService } from './analytics-settings.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Analytics (F-1001): the rollup every figure is read from and the worker that
 * rebuilds it (F-1001-a), the tabs that read it (F-1001-b) and their files
 * (F-1007-a, `LocaleModule` for the reader's words), and the tenant's
 * renewal window (F-1001-f), the daily loss alert (F-1003), and a person's
 * scheduled reports (F-1006-a). `PrismaModule`
 * is `@Global()` and binds `RESELLER_ACCESS_READER` beside it.
 */
@Module({
  imports: [LocaleModule],
  controllers: [AnalyticsController, AnalyticsReportsController, AnalyticsInternalController],
  providers: [AnalyticsRollupService, AnalyticsLossService, AnalyticsService, AnalyticsExportService, AnalyticsSettingsService, AnalyticsReportService, AnalyticsReportSender, ResellerAccess],
  exports: [AnalyticsRollupService],
})
export class AnalyticsModule {}
