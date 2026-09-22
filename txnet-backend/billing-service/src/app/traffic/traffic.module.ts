import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';
import { BlockPurchaseService } from './block-purchase';
import { CeilingAllocatorService } from './ceiling-allocator';
import { RemainderCreditService } from './remainder-credit';

/**
 * Metered traffic's money side (F-027-q, ADR-0072). In-process only: the hot
 * loop (F-027-u) and the Grant close (F-027-r) call these inside their own
 * transactions. No route until a row needs one.
 */
@Module({
  imports: [WalletModule],
  providers: [BlockPurchaseService, RemainderCreditService, CeilingAllocatorService],
  exports: [BlockPurchaseService, RemainderCreditService, CeilingAllocatorService],
})
export class TrafficModule {}
