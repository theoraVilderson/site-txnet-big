import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ok, ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import { ProfileBuilder } from './profile-builder.service';

/**
 * The seam `worker-service`'s `ai_profile_rebuild` job reaches the hourly
 * rebuild through (F-038-c). `worker-service` owns *when* (ADR-0027: a
 * schedule is a message); this service owns *what*, because its two pools and
 * its policy are here.
 *
 * Service callers only — `ServiceOnlyGuard` answers anyone else a neutral 404 —
 * and outside any tenant: the run resolves every tenant it touches itself.
 * No Traefik route reaches this service at all.
 */
@TenantCapability('system')
@Controller('api/internal/ai/profiles')
@UseGuards(ServiceOnlyGuard)
export class ProfileInternalController {
  constructor(private readonly builder: ProfileBuilder) {}

  /** Rebuild every running tenant's profiles; answers its counts in the success envelope the worker reads. */
  @Post('rebuild')
  @HttpCode(200)
  async rebuild() {
    return ok(await this.builder.rebuildAll());
  }
}
