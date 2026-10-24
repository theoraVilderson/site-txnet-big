import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Ip, NotFoundException, Param, ParseUUIDPipe, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '@txnet-backend/shared-core';

import { identityOf } from '../request/identity.middleware';
import { PlatformPermissionGuard, PlatformRoute } from '../request/platform-permission.guard';
import {
  SetReleaseFlagExceptionInput,
  SetReleaseFlagStageInput,
  setReleaseFlagExceptionSchema,
  setReleaseFlagStageSchema,
} from './release-flags.schema';
import { ReleaseFlagView, ReleaseFlagsActor, ReleaseFlagsRefused, ReleaseFlagsRejection, ReleaseFlagsService } from './release-flags.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ReleaseFlagsRejection, 403 | 404> = {
  not_platform_owner: 403,
  unknown_flag: 404,
  reseller_not_found: 404,
};

/**
 * The platform's release flags (OPS-1-ag, `tenant/contract.release-flags.md`):
 *
 *  - `GET tenants/release-flags` — every flag, its stage and its exceptions;
 *  - `PUT tenants/release-flags/:key` — `{stage: off | platform | everyone}`;
 *  - `PUT|DELETE tenants/release-flags/:key/tenants/:tenantId` — one
 *    reseller's own `{isOn}`, or none (the stage decides again).
 *
 * Writes answer `204`; the table is read again.
 */
@Controller('tenants/release-flags')
@UseGuards(PlatformPermissionGuard)
@PlatformRoute('platform.release.manage')
export class ReleaseFlagsController {
  constructor(private readonly flags: ReleaseFlagsService) {}

  @Get()
  table(@Req() req: Request, @Ip() ip: string): Promise<ReleaseFlagView[]> {
    return refusing(() => this.flags.table(actorOf(req, ip)));
  }

  @Put(':key')
  @HttpCode(204)
  setStage(@Req() req: Request, @Ip() ip: string, @Param('key') key: string, @Body(new ZodValidationPipe(setReleaseFlagStageSchema)) body: SetReleaseFlagStageInput) {
    return refusing(() => this.flags.setStage(actorOf(req, ip), key, body.stage));
  }

  @Put(':key/tenants/:tenantId')
  @HttpCode(204)
  setException(
    @Req() req: Request,
    @Ip() ip: string,
    @Param('key') key: string,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(setReleaseFlagExceptionSchema)) body: SetReleaseFlagExceptionInput,
  ) {
    return refusing(() => this.flags.setException(actorOf(req, ip), key, tenantId, body.isOn));
  }

  @Delete(':key/tenants/:tenantId')
  @HttpCode(204)
  clearException(@Req() req: Request, @Ip() ip: string, @Param('key') key: string, @Param('tenantId', new ParseUUIDPipe()) tenantId: string) {
    return refusing(() => this.flags.clearException(actorOf(req, ip), key, tenantId));
  }
}

/**
 * `GET tenants/release-flags/mine` — `{<key>: boolean}` for the caller's own
 * tenant, any signed-in caller: the panel's door to hide what a flag covers.
 * Who may use the feature behind it is still each route's own check.
 */
@Controller('tenants/release-flags/mine')
export class ReleaseFlagsMineController {
  constructor(private readonly flags: ReleaseFlagsService) {}

  @Get()
  mine(@Req() req: Request): Promise<Record<string, boolean>> {
    return this.flags.answersFor(identityOf(req).tenantId);
  }
}

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof ReleaseFlagsRefused)) throw e;
    const payload = { reason: e.reason, message: e.message };
    throw STATUS[e.reason] === 403 ? new ForbiddenException(payload) : new NotFoundException(payload);
  }
}

function actorOf(req: Request, ip: string): ReleaseFlagsActor {
  const { userId, tenantId } = identityOf(req);
  return { adminId: userId, tenantId, ip };
}
