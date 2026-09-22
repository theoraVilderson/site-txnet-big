import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';
import { BlockPurchaseService } from './block-purchase';

/**
 * Metered traffic's money side (F-027-q, ADR-0072). In-process only: the
 * ceiling allocator (F-027-s) and the Grant close (F-027-r) call it inside
 * their own transactions. No route until a row needs one.
 */
@Module({
  imports: [WalletModule],
  providers: [BlockPurchaseService],
  exports: [BlockPurchaseService],
})
export class TrafficModule {}
