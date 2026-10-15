import { Module } from '@nestjs/common';

import { AnalyticsInternalController } from './analytics-internal.controller';
import { AnalyticsRollupService } from './analytics-rollup.service';

/**
 * The analytics rollup (F-1001-a): the tables every analytics figure is read
 * from, and the worker that rebuilds them. `PrismaModule` is `@Global()`.
 */
@Module({
  controllers: [AnalyticsInternalController],
  providers: [AnalyticsRollupService],
  exports: [AnalyticsRollupService],
})
export class AnalyticsModule {}
