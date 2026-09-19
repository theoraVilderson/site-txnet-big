import { Controller, ConflictException, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ResellerAccessRefused } from '@txnet-backend/shared-core';

import { identityOf } from '../request/identity.middleware';
import { OnboardingActor, OnboardingRejection, OnboardingView, TenantOnboardingService } from './tenant-onboarding.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<OnboardingRejection, 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
};

/**
 * The configuration console's checklist (F-018-l): `GET /api/tenants/:id/onboarding`.
 *
 * No `TenantPermissionGuard`: the reseller's owner holds no `tenant.manage`
 * and is let in by `ResellerAccess`, as its staff and the platform owner's are.
 * A `read`, so a suspended reseller still sees what it would have to do.
 */
@Controller('tenants/:id/onboarding')
export class TenantOnboardingController {
  constructor(private readonly onboarding: TenantOnboardingService) {}

  @Get()
  async checklist(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<OnboardingView> {
    try {
      return await this.onboarding.checklist(actorOf(req), id);
    } catch (e) {
      if (!(e instanceof ResellerAccessRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (STATUS[e.reason]) {
        case 403:
          throw new ForbiddenException(payload);
        case 404:
          throw new NotFoundException(payload);
        default:
          throw new ConflictException(payload);
      }
    }
  }
}

function actorOf(req: Request): OnboardingActor {
  const identity = identityOf(req);
  return { userId: identity.userId, tenantId: identity.tenantId, permissions: identity.permissions };
}
