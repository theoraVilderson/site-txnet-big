import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';
import { BlockPurchaseService } from './block-purchase';
import { BlockRequestService } from './block-request';
import { CeilingAllocatorService } from './ceiling-allocator';
import { CollectionHealthController } from './collection-health.controller';
import { CollectionHealthService } from './collection-health';
import { ConfigActionsService } from './config-actions';
import { GroupFulfilmentController } from './group-fulfilment.controller';
import { GroupFulfilmentService } from './group-fulfilment';
import { GroupDrainService } from './group-drain';
import { HotLoopService } from './horizon';
import { HotLoopConsumer } from './hot-loop.consumer';
import { HotLoopQueue } from './hot-loop.queue';
import { HotLoopSweepController } from './hot-loop.sweep.controller';
import { HotLoopSweepService } from './hot-loop.sweep';
import { RemainderCreditService } from './remainder-credit';
import { UserConfigsController } from './user-configs.controller';
import { UserConfigsService } from './user-configs';
import { GrantUsageService } from './grant-usage';

/**
 * Metered traffic's money side (F-027-q, ADR-0072). In-process only: the hot
 * loop (F-027-u) and the Grant close (F-027-r) call these inside their own
 * transactions. Its routes are the user's: the collection-health flag
 * (F-027-w), which reads the collector's progress mark, and a Grant's configs
 * with the two actions a user may take on them (F-027-ac). None moves money.
 *
 * `BlockRequestService` buys a metered Grant's next block when the lease
 * planner asks for it (F-027-dc) — the only path that buys one.
 * `HotLoopService` measures rates and asks exhaustion; it buys nothing since
 * F-027-dc. `HotLoopQueue` is the caller of both — this service's own queue
 * on `network.usage.#` and the planner's block requests, one top-up per Grant
 * a pass touched (F-027-cl, ADR-0092). `HotLoopSweepService` is its
 * second, for the Grants no pass touches: a config cut off at its share, asked
 * by `worker-service` over `hot-loop/sweep-due` (F-027-cn).
 *
 * `ConfigActionsService` is every action on a config as a desired-state write
 * (F-027-z); `network-service` carries it to the panel, nothing here does.
 * `GroupFulfilmentService` places a panel group's configs through it and
 * activates the Grant (F-027-bl), asked by `worker-service` over `fulfil-due`;
 * `GroupDrainService` retires a drained member's configs through it (F-027-bm),
 * over `drain-due`.
 */
@Module({
  imports: [WalletModule],
  controllers: [CollectionHealthController, UserConfigsController, GroupFulfilmentController, HotLoopSweepController],
  providers: [BlockPurchaseService, BlockRequestService, RemainderCreditService, CeilingAllocatorService, HotLoopService, HotLoopConsumer, HotLoopQueue, HotLoopSweepService, CollectionHealthService, ConfigActionsService, UserConfigsService, GrantUsageService, GroupFulfilmentService, GroupDrainService],
  exports: [BlockPurchaseService, RemainderCreditService, CeilingAllocatorService, HotLoopService, ConfigActionsService, GroupFulfilmentService, UserConfigsService, GrantUsageService],
})
export class TrafficModule {}
