import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';
import { BlockPurchaseService } from './block-purchase';
import { CeilingAllocatorService } from './ceiling-allocator';
import { CollectionHealthController } from './collection-health.controller';
import { CollectionHealthService } from './collection-health';
import { HotLoopService } from './horizon';
import { RemainderCreditService } from './remainder-credit';

/**
 * Metered traffic's money side (F-027-q, ADR-0072). In-process only: the hot
 * loop (F-027-u) and the Grant close (F-027-r) call these inside their own
 * transactions. One route: the collection-health flag (F-027-w), which reads
 * the collector's progress mark and moves no money.
 *
 * `HotLoopService` is the hot loop's money half: it sizes the next block from
 * the measured rate and calls the other two in one transaction.
 */
@Module({
  imports: [WalletModule],
  controllers: [CollectionHealthController],
  providers: [BlockPurchaseService, RemainderCreditService, CeilingAllocatorService, HotLoopService, CollectionHealthService],
  exports: [BlockPurchaseService, RemainderCreditService, CeilingAllocatorService, HotLoopService],
})
export class TrafficModule {}
