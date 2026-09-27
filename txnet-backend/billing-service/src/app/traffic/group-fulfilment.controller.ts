import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import type { ClosedVerdict } from './exhaustion';
import { GrantCloseService } from './grant-close';
import { DrainDueResult, GroupDrainService } from './group-drain';
import { FulfilDueResult, FulfilNowOutcome, GroupFulfilmentService } from './group-fulfilment';

/**
 * The seam `worker-service`'s `grant_group_fulfilment` tick reaches group
 * fulfilment and draining through (F-027-bl, F-027-bm), as `purge-due` is reached (F-027-y): the scan
 * is cross-tenant and every write is not, and both pools are here.
 *
 * Outside the gate and outside the tenant — `/api/internal/*` has no edge
 * router, and `ServiceOnlyGuard` refuses any other caller as a neutral 404.
 * Safe to run twice (ADR-0027): each scan names only what has a write due.
 */
@TenantCapability('system')
@Controller('internal/billing/network')
@UseGuards(ServiceOnlyGuard)
export class GroupFulfilmentController {
  constructor(
    private readonly fulfilment: GroupFulfilmentService,
    private readonly drain: GroupDrainService,
    private readonly close: GrantCloseService,
  ) {}

  /** One batch: place the configs that are due, activate the Grants that are. Raw counts, for the job's run log. */
  @Post('fulfil-due')
  @HttpCode(200)
  fulfilDue(): Promise<FulfilDueResult> {
    return this.fulfilment.fulfilDue();
  }

  /**
   * One Grant, now: a config of it was confirmed on its panel (F-111-n).
   * Only a `pending` Grant is looked at, so a repeat answers `skipped`; the
   * answer is `{ outcome }` in the usual envelope.
   */
  @Post('grants/:grantId/fulfil')
  @HttpCode(200)
  async fulfilNow(@Param('grantId', new ParseUUIDPipe()) grantId: string): Promise<{ outcome: FulfilNowOutcome }> {
    return { outcome: await this.fulfilment.fulfilNow(grantId) };
  }

  /**
   * One Grant, now: the lease planner closed it (F-027-dw, ADR-0096). A
   * prepaid one still on its Quota is suspended for quota; anything else
   * answers why not. A repeat finds it no longer `active` (`not_active`).
   */
  @Post('grants/:grantId/closed')
  @HttpCode(200)
  async closed(@Param('grantId', new ParseUUIDPipe()) grantId: string): Promise<{ outcome: ClosedVerdict }> {
    return { outcome: await this.close.onClosed(grantId) };
  }

  /** One batch: retire the drained configs whose wait is over, remove the members left bare. */
  @Post('drain-due')
  @HttpCode(200)
  drainDue(): Promise<DrainDueResult> {
    return this.drain.drainDue();
  }
}
