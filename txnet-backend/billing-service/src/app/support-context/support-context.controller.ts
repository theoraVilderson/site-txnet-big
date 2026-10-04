import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import { SupportContextService, SupportUserFacts } from './support-context';

/**
 * The seam support's agent sidebar reads through (F-033-m). Outside the gate
 * like every `/api/internal/*` route — `ServiceOnlyGuard`, a neutral 404 to
 * anything else — and outside the tenant, so the tenant is the path's: the
 * caller (support-service) found the conversation in it first.
 */
@TenantCapability('system')
@Controller('internal/billing/tenants/:tenantId/users/:userId/support-context')
@UseGuards(ServiceOnlyGuard)
export class SupportContextController {
  constructor(private readonly context: SupportContextService) {}

  @Get()
  of(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<SupportUserFacts> {
    return this.context.of(tenantId, userId);
  }
}
