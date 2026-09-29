import { Module } from '@nestjs/common';
import { TenantBillingLedger } from '@txnet-backend/shared-core';

import { WalletModule } from '../wallet/wallet.module';
import { SpendingCapController } from './spending-cap.controller';
import { SpendingCapService } from './spending-cap';
import { UsageDoorService } from './usage-door';
import { UsageInternalController } from './usage-internal.controller';
import { UsageRefundService } from './usage-refund';
import { UsageSettlementService } from './usage-settlement';

/**
 * Rating and settlement of a Grant's meters (F-118-g, ADR-0105). In-process:
 * `UsageDoorService` is the per-use door (F-118-h) — authorize, commit,
 * cancel — the enforcer of every `DOOR_METERS` meter; it charges the
 * reseller's billing wallet too, so it holds its own `TenantBillingLedger`.
 * One sweep, the hourly postpaid capture and token expiry, asked by
 * `worker-service` over the internal seam (ADR-0027). The owner's
 * spending cap on one Grant (F-118-i) is set here; every funding path reads it
 * through `withinCap` (`spending-cap.ts`).
 */
@Module({
  imports: [WalletModule],
  controllers: [UsageInternalController, SpendingCapController],
  providers: [UsageSettlementService, UsageRefundService, UsageDoorService, SpendingCapService, TenantBillingLedger],
  exports: [UsageSettlementService, UsageDoorService],
})
export class UsageModule {}
