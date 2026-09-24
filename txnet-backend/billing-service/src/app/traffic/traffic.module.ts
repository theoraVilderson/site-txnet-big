import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';
import { BlockPurchaseService } from './block-purchase';
import { CeilingAllocatorService } from './ceiling-allocator';
import { CollectionHealthController } from './collection-health.controller';
import { CollectionHealthService } from './collection-health';
import { ConfigActionsService } from './config-actions';
import { GroupFulfilmentController } from './group-fulfilment.controller';
import { GroupFulfilmentService } from './group-fulfilment';
import { HotLoopService } from './horizon';
import { RemainderCreditService } from './remainder-credit';
import { UserConfigsController } from './user-configs.controller';
import { UserConfigsService } from './user-configs';

/**
 * Metered traffic's money side (F-027-q, ADR-0072). In-process only: the hot
 * loop (F-027-u) and the Grant close (F-027-r) call these inside their own
 * transactions. Its routes are the user's: the collection-health flag
 * (F-027-w), which reads the collector's progress mark, and a Grant's configs
 * with the two actions a user may take on them (F-027-ac). None moves money.
 *
 * `HotLoopService` is the hot loop's money half: it sizes the next block from
 * the measured rate and calls the other two in one transaction.
 *
 * `ConfigActionsService` is every action on a config as a desired-state write
 * (F-027-z); `network-service` carries it to the panel, nothing here does.
 * `GroupFulfilmentService` places a panel group's configs through it and
 * activates the Grant (F-027-bl), asked by `worker-service` over `fulfil-due`.
 */
@Module({
  imports: [WalletModule],
  controllers: [CollectionHealthController, UserConfigsController, GroupFulfilmentController],
  providers: [BlockPurchaseService, RemainderCreditService, CeilingAllocatorService, HotLoopService, CollectionHealthService, ConfigActionsService, UserConfigsService, GroupFulfilmentService],
  exports: [BlockPurchaseService, RemainderCreditService, CeilingAllocatorService, HotLoopService, ConfigActionsService],
})
export class TrafficModule {}
