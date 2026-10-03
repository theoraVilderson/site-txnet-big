import { Module } from '@nestjs/common';
import { KekService } from '@txnet-backend/shared-core';

import { EntitlementModule } from '../entitlement/entitlement.module';
import { LotteryAdminController } from './lottery-admin.controller';
import { LotteryAdminService } from './lottery-admin.service';
import { LotteryCloseService } from './lottery-close.service';
import { LotteryDeliveryService } from './lottery-delivery.service';
import { LotteryDrawService } from './lottery-draw.service';
import { LotteryEntryService } from './lottery-entry.service';
import { LotteryInternalController } from './lottery-internal.controller';
import { LotteryResultService } from './lottery-result.service';
import { LotterySeedSeal } from './lottery-seed-seal';
import { LotteryController } from './lottery.controller';
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
 * issuer its `GrantService`; `KekService` seals a lottery's seed (F-707-k).
 */
@Module({
  imports: [EntitlementModule],
  controllers: [WheelAdminController, WheelController, LotteryAdminController, LotteryController, LotteryInternalController],
  providers: [WheelAdminService, LotteryAdminService, LotteryEntryService, LotteryCloseService, LotteryDrawService, LotteryDeliveryService, LotteryResultService, LotterySeedSeal, KekService, WheelSpinService, WheelReportService],
})
export class EngagementModule {}
