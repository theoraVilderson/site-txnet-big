import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import { ReserveDueResult, VpnReserveSweep } from './vpn-reserve';

/**
 * The seam `worker-service`'s `vpn_reserve` tick reaches the reserve sweep
 * through (F-118-b). Outside the gate and outside the tenant, as
 * `UsageInternalController` is: the scan is cross-tenant and each write opens
 * its Grant's tenant. Safe to run twice: a reserve at its target writes nothing.
 */
@TenantCapability('system')
@Controller('internal/billing/traffic')
@UseGuards(ServiceOnlyGuard)
export class VpnReserveController {
  constructor(private readonly sweep: VpnReserveSweep) {}

  /** Every metered Grant's reserve topped to its target, every stale one released. Raw counts, for the job's log. */
  @Post('reserve-due')
  @HttpCode(200)
  reserveDue(): Promise<ReserveDueResult> {
    return this.sweep.reserveDue();
  }
}
