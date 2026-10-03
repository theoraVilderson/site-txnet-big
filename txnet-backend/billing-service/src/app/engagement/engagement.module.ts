import { Module } from '@nestjs/common';

import { EntitlementModule } from '../entitlement/entitlement.module';
import { LotteryAdminController } from './lottery-admin.controller';
import { LotteryAdminService } from './lottery-admin.service';
import { WheelAdminController } from './wheel-admin.controller';
import { WheelAdminService } from './wheel-admin.service';
import { WheelReportService } from './wheel-report';
import { WheelSpinService } from './wheel-spin.service';
import { WheelController } from './wheel.controller';

/**
 * The wheel and the lottery (F-707, ADR-0111 point 1): a module of
 * `billing-service`, so a prize and its spin commit in one transaction. Tables
 * in the `engagement` schema; no other unit writes them.
 *
 * `PrismaModule` is `@Global()`; `EntitlementModule` lends the reward
 * issuer its `GrantService`.
 */
@Module({
  imports: [EntitlementModule],
  controllers: [WheelAdminController, WheelController, LotteryAdminController],
  providers: [WheelAdminService, LotteryAdminService, WheelSpinService, WheelReportService],
})
export class EngagementModule {}
