import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import { FulfilDueResult, GroupFulfilmentService } from './group-fulfilment';

/**
 * The seam `worker-service`'s `grant_group_fulfilment` tick reaches group
 * fulfilment through (F-027-bl), as `purge-due` is reached (F-027-y): the scan
 * is cross-tenant and every write is not, and both pools are here.
 *
 * Outside the gate and outside the tenant — `/api/internal/*` has no edge
 * router, and `ServiceOnlyGuard` refuses any other caller as a neutral 404.
 * Safe to run twice (ADR-0027): the scan names only Grants with a write due.
 */
@TenantCapability('system')
@Controller('internal/billing/network')
@UseGuards(ServiceOnlyGuard)
export class GroupFulfilmentController {
  constructor(private readonly fulfilment: GroupFulfilmentService) {}

  /** One batch: place the configs that are due, activate the Grants that are. Raw counts, for the job's run log. */
  @Post('fulfil-due')
  @HttpCode(200)
  fulfilDue(): Promise<FulfilDueResult> {
    return this.fulfilment.fulfilDue();
  }
}
