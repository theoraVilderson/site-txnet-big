import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import { CaptureDueResult, UsageSettlementService } from './usage-settlement';

/**
 * The seam `worker-service` reaches the postpaid capture through (F-118-g).
 * Outside the gate and outside the tenant, as `EntitlementInternalController`
 * is: the scan is cross-tenant and each capture opens its meter's tenant.
 *
 * **Safe to run twice** (ADR-0027): a capture moves `billed` to what it
 * charged, so a second call in the same hour finds nothing due.
 */
@TenantCapability('system')
@Controller('internal/billing/usage')
@UseGuards(ServiceOnlyGuard)
export class UsageInternalController {
  constructor(private readonly settlement: UsageSettlementService) {}

  /** Every active postpaid meter with usage past its cursor, captured and its hold restored. Raw counts, for the job's log. */
  @Post('capture-due')
  @HttpCode(200)
  captureDue(): Promise<CaptureDueResult> {
    return this.settlement.captureDue();
  }
}
