import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import { UsageDoorService } from './usage-door';
import { CaptureDueResult, UsageSettlementService } from './usage-settlement';

/**
 * The seam `worker-service` reaches the postpaid capture through (F-118-g).
 * Outside the gate and outside the tenant, as `EntitlementInternalController`
 * is: the scan is cross-tenant and each capture opens its meter's tenant.
 *
 * **Safe to run twice** (ADR-0027): a capture moves `billed` to what it
 * charged, so a second call in the same hour finds nothing due; an expired
 * per-use token is no longer open.
 */
@TenantCapability('system')
@Controller('internal/billing/usage')
@UseGuards(ServiceOnlyGuard)
export class UsageInternalController {
  constructor(
    private readonly settlement: UsageSettlementService,
    private readonly door: UsageDoorService,
  ) {}

  /**
   * Every per-use token past its time expired and its money given back
   * (F-118-h), then every active postpaid meter with usage past its cursor
   * captured and its hold restored. Raw counts, for the job's log; the
   * expiry's errors are counted in `errors`.
   */
  @Post('capture-due')
  @HttpCode(200)
  async captureDue(): Promise<CaptureDueResult & { expired: number }> {
    const expiry = await this.door.expireDue();
    const capture = await this.settlement.captureDue();
    return { ...capture, errors: capture.errors + expiry.errors, expired: expiry.expired };
  }
}
