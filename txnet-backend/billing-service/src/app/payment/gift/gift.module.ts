import { Module } from '@nestjs/common';

import { WalletModule } from '../../wallet/wallet.module';
import { GiftController } from './gift.controller';
import { GiftRedemptionService } from './gift-redemption.service';

/**
 * The gift-code box (F-092-m). It needs no coupon provider: the discount engine
 * refuses a `wallet_credit` coupon by design, so the gates are the migration's
 * function and the money moves through `WalletLedgerService`.
 */
@Module({
  imports: [WalletModule],
  controllers: [GiftController],
  providers: [GiftRedemptionService],
  exports: [GiftRedemptionService],
})
export class GiftModule {}
