import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';
import { SpendingCapController } from './spending-cap.controller';
import { SpendingCapService } from './spending-cap';
import { UsageInternalController } from './usage-internal.controller';
import { UsageRefundService } from './usage-refund';
import { UsageSettlementService } from './usage-settlement';

/**
 * Rating and settlement of a Grant's meters (F-118-g, ADR-0105). In-process:
 * the per-use door (F-118-h) buys blocks, tops holds up and settles at close
 * through `UsageSettlementService`. One sweep, the hourly postpaid capture,
 * asked by `worker-service` over the internal seam (ADR-0027). The owner's
 * spending cap on one Grant (F-118-i) is set here; every funding path reads it
 * through `withinCap` (`spending-cap.ts`).
 */
@Module({
  imports: [WalletModule],
  controllers: [UsageInternalController, SpendingCapController],
  providers: [UsageSettlementService, UsageRefundService, SpendingCapService],
  exports: [UsageSettlementService],
})
export class UsageModule {}
