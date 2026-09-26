import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import { HotLoopSweepService, SweepDueResult } from './hot-loop.sweep';

/**
 * The seam `worker-service`'s `hot_loop_sweep` tick reaches the hot loop's
 * sweep through (F-027-cn), as `fulfil-due` is reached: the scan is
 * cross-tenant and every write is not, and both pools are here.
 *
 * Outside the gate and outside the tenant — `/api/internal/*` has no edge
 * router, and `ServiceOnlyGuard` refuses any other caller as a neutral 404.
 * Safe to run twice (ADR-0027): the scan names only a split still to move.
 */
@TenantCapability('system')
@Controller('internal/billing/network')
@UseGuards(ServiceOnlyGuard)
export class HotLoopSweepController {
  constructor(private readonly sweep: HotLoopSweepService) {}

  /** One batch: re-split each Grant with a config cut off at its share. Raw counts, for the job's run log. */
  @Post('hot-loop/sweep-due')
  @HttpCode(200)
  sweepDue(): Promise<SweepDueResult> {
    return this.sweep.sweepDue();
  }
}
