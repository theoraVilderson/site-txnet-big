import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import { SupportRetention } from './retention';

/**
 * worker-service's daily `support_retention` (F-033-n), with
 * `SERVICE_AUTH_TOKEN` (ADR-0011). Not routed by Traefik; a wrong token is a
 * 404. Crosses every tenant, so it carries none (`'system'`).
 */
@TenantCapability('system')
@Controller('internal/support')
@UseGuards(ServiceOnlyGuard)
export class SupportRetentionInternalController {
  constructor(private readonly retention: SupportRetention) {}

  @Post('retention')
  @HttpCode(200)
  run(): Promise<{ expired: number; months: string[] }> {
    return this.retention.run();
  }
}
