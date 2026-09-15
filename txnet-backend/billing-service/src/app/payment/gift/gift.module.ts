import { Module } from '@nestjs/common';

import { EntitlementModule } from '../../entitlement/entitlement.module';
import { WalletModule } from '../../wallet/wallet.module';
import { GiftController } from './gift.controller';
import { GiftRedemptionService } from './gift-redemption.service';

/**
 * The gift-code box (F-092-m). It needs no coupon provider: the discount engine
 * refuses a `wallet_credit` coupon by design, so the gates are the migration's
 * function and the money moves through `WalletLedgerService` — or, for a
 * free-service code, the Grant through `GrantService` (F-502-l-b).
 */
@Module({
  imports: [WalletModule, EntitlementModule],
  controllers: [GiftController],
  providers: [GiftRedemptionService],
  exports: [GiftRedemptionService],
})
export class GiftModule {}
