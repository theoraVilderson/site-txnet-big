import { Injectable, Logger } from '@nestjs/common';
import { WalletVersionConflict, runWithTenant } from '@txnet-backend/shared-core';

import { errorLine } from '../log-line';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { HotLoopService } from './horizon';

export type SweepDueResult = { scanned: number; rebalanced: number; bought: number; raced: number; failed: number };

/** Grants per sweep. The scan names only Grants with a split to move, so a batch drains. */
const SWEEP_BATCH_SIZE = 200;

/**
 * The hot loop's second caller (F-027-cn, ADR-0092 amendment): the Grants the
 * delta stream never names.
 *
 * The delta stream calls `topUp` for every Grant a pass carried a delta for
 * (`hot-loop.consumer.ts`). A config the panel cut off at its own share sends
 * none, and where its Grant's other configs are idle nothing else does either,
 * so the bag stays split while one half is unspent. This names exactly those
 * Grants — active, bytes left in the bag, and some active config that has
 * served up to its share — and runs the same `topUp` on each, which re-splits
 * the bag onto the cut-off config (`horizon.ts`, "a config is hot on its own
 * share too"). The convergence pass then raises the panel's ceiling and
 * re-enables the client.
 *
 * **Safe to run twice** (ADR-0027): after the split the config's share is
 * above what it served, so a second scan does not name it. The scan is
 * cross-tenant; each top-up runs in its Grant's tenant, as the consumer's do.
 */
@Injectable()
export class HotLoopSweepService {
  private readonly logger = new Logger(HotLoopSweepService.name);

  constructor(
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly hot: HotLoopService,
  ) {}

  async sweepDue(): Promise<SweepDueResult> {
    const due = await this.crossTenant.$queryRaw<{ id: string; tenantId: string }[]>`
      SELECT g."id", g."tenantId"
        FROM "entitlement"."grant" g
       WHERE g."status" = 'active'
         AND NOT g."trafficUnlimited"
         AND g."purchasedBytes" > g."consumedBytes"
         AND EXISTS (
               SELECT 1 FROM "network"."config" c
                 JOIN "network"."config_counter_state" s ON s."configId" = c."id"
                WHERE c."grantId" = g."id"
                  AND c."status" = 'active'
                  AND c."desiredEnabled"
                  AND c."allocatedCeilingBytes" IS NOT NULL
                  AND s."lifetimeUpBytes" + s."lifetimeDownBytes" >= c."allocatedCeilingBytes")
       ORDER BY g."createdAt" ASC
       LIMIT ${SWEEP_BATCH_SIZE}`;

    const result: SweepDueResult = { scanned: due.length, rebalanced: 0, bought: 0, raced: 0, failed: 0 };
    for (const grant of due) {
      try {
        const outcome = await runWithTenant({ id: grant.tenantId }, () => this.hot.topUp({ grantId: grant.id }));
        if (outcome.rebalanced) result.rebalanced += 1;
        if (outcome.bought) result.bought += 1;
      } catch (e) {
        // Another pass bought first: routine, and it left the split moved.
        if (e instanceof WalletVersionConflict) {
          result.raced += 1;
          continue;
        }
        // That Grant's alone; the next tick names it again.
        result.failed += 1;
        this.logger.warn(`hot loop sweep of grant ${grant.id} failed: ${errorLine(e)}`);
      }
    }
    if (result.rebalanced > 0 || result.bought > 0) {
      this.logger.log(`hot loop sweep: re-split ${result.rebalanced}, bought for ${result.bought} of ${due.length} Grant(s)`);
    }
    return result;
  }
}
