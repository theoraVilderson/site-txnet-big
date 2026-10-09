import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { TenantCapability } from '@txnet-backend/shared-core';

import { ServiceOnlyGuard } from '../../common/guards/service-only.guard';
import { TenantAgnostic } from '../../tenant/tenant-agnostic.decorator';
import { MembershipEndSweep } from './membership-end.sweep';

/**
 * `POST /api/internal/user-groups/end-memberships` (GR-1-c) — the seam
 * `worker-service`'s `group_membership_end` job calls, as
 * `invoice_pending_expiry` calls billing's. Service callers only (a neutral
 * 404 otherwise). `@TenantAgnostic`: the job names no tenant — the sweep
 * reads every tenant's ended memberships and acts on each in its own scope.
 */
@TenantCapability('system')
@Controller('internal/user-groups')
@UseGuards(ServiceOnlyGuard)
@TenantAgnostic()
export class MembershipEndInternalController {
  constructor(private readonly sweep: MembershipEndSweep) {}

  @Post('end-memberships')
  @HttpCode(HttpStatus.OK)
  endMemberships(): Promise<{ ended: number; told: number }> {
    return this.sweep.endDue();
  }
}
