import { Controller, ConflictException, Delete, ForbiddenException, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseEnumPipe, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { TenantOnboardingOptionalStep } from '@prisma/client';
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
 * The configuration console's checklist (F-018-l): `GET /api/tenants/:id/onboarding`,
 * and an optional step's skip (F-213): `PUT` / `DELETE .../onboarding/skips/:step`
 * — 204, the page re-reads the checklist. A step that is not optional is a 400
 * from the pipe: the required steps are done by live rows alone.
 *
 * No `PlatformPermissionGuard`: the reseller's owner holds no platform key
 * and is let in by `ResellerAccess`, as its staff and the platform owner's are.
 * The checklist is a `read`, so a suspended reseller still sees what it would
 * have to do; a skip is the default `staffWrite`.
 */
@Controller('tenants/:id/onboarding')
export class TenantOnboardingController {
  constructor(private readonly onboarding: TenantOnboardingService) {}

  @Get()
  checklist(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<OnboardingView> {
    return refusing(() => this.onboarding.checklist(actorOf(req), id));
  }

  @Put('skips/:step')
  @HttpCode(HttpStatus.NO_CONTENT)
  skip(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('step', new ParseEnumPipe(TenantOnboardingOptionalStep)) step: TenantOnboardingOptionalStep,
  ): Promise<void> {
    return refusing(() => this.onboarding.skip(actorOf(req), id, step));
  }

  @Delete('skips/:step')
  @HttpCode(HttpStatus.NO_CONTENT)
  unskip(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('step', new ParseEnumPipe(TenantOnboardingOptionalStep)) step: TenantOnboardingOptionalStep,
  ): Promise<void> {
    return refusing(() => this.onboarding.unskip(actorOf(req), id, step));
  }
}

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
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

function actorOf(req: Request): OnboardingActor {
  const identity = identityOf(req);
  return { userId: identity.userId, tenantId: identity.tenantId, permissions: identity.permissions };
}
