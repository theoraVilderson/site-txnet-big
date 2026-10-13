import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { TenantCapability } from '@txnet-backend/shared-core';

import { ServiceOnlyGuard } from '../../common/guards/service-only.guard';
import { TenantAgnostic } from '../../tenant/tenant-agnostic.decorator';
import { KeyWindowSweep } from './key-window.sweep';

/**
 * `POST /api/internal/user-keys/windows` (F-030-a) — the seam
 * `worker-service`'s `key_window` job calls, as `group_membership_end` calls
 * GR-1-c's. Service callers only (a neutral 404 otherwise). `@TenantAgnostic`:
 * the sweep reads every tenant's due windows and acts on each in its own scope.
 */
@TenantCapability('system')
@Controller('internal/user-keys')
@UseGuards(ServiceOnlyGuard)
@TenantAgnostic()
export class KeyWindowInternalController {
  constructor(private readonly sweep: KeyWindowSweep) {}

  @Post('windows')
  @HttpCode(HttpStatus.OK)
  moveWindows(): Promise<{ opened: number; closed: number; told: number }> {
    return this.sweep.moveDue();
  }
}
