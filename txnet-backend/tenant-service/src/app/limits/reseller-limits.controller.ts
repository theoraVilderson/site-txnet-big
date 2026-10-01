import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ResellerAccessRefused, type ResellerAccessRejection } from '@txnet-backend/shared-core';

import { identityOf } from '../request/identity.middleware';
import { TenantPermissionGuard } from '../request/tenant-permission.guard';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import {
  ClearResellersLimitInput,
  clearResellersLimitSchema,
  SetLimitInput,
  setLimitSchema,
  SetResellersLimitInput,
  setResellersLimitSchema,
} from './reseller-limits.schema';
import { LimitInEffectRow, LimitRow, ResellerLimitsActor, ResellerLimitsRefused, ResellerLimitsRejection, ResellerLimitsService } from './reseller-limits.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ResellerLimitsRejection, 403 | 404 | 422> = {
  not_platform_owner: 403,
  unknown_limit: 404,
  package_not_found: 404,
  reseller_not_found: 404,
  limit_out_of_range: 422,
};

/**
 * Reseller limits, the platform owner's (F-019-m, ADR-0106), under
 * `/api/tenants/limits/…` — three segments or more, so nothing here is read
 * as `GET /api/tenants/:id`:
 *
 *  - `GET  settings` — every key, every level that sets it;
 *  - `PUT|DELETE settings/:key` — the platform's value (`DELETE`: the code default);
 *  - `PUT|DELETE packages/:packageId/:key` — a package's;
 *  - `PUT resellers/:key`, `POST resellers/:key/clear` — one or several
 *    resellers' own, `{tenantIds, value, reason}` / `{tenantIds}`.
 *
 * `value` null is no limit. Writes answer `204`; the table is read again.
 */
@Controller('tenants/limits')
@UseGuards(TenantPermissionGuard)
export class ResellerLimitsController {
  constructor(private readonly limits: ResellerLimitsService) {}

  @Get('settings')
  table(@Req() req: Request, @Ip() ip: string): Promise<LimitRow[]> {
    return this.refusing(() => this.limits.table(actorOf(req, ip)));
  }

  @Put('settings/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  setPlatform(@Req() req: Request, @Ip() ip: string, @Param('key') key: string, @Body(new ZodValidationPipe(setLimitSchema)) body: SetLimitInput) {
    return this.refusing(() => this.limits.setPlatform(actorOf(req, ip), key, body.value));
  }

  @Delete('settings/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  clearPlatform(@Req() req: Request, @Ip() ip: string, @Param('key') key: string) {
    return this.refusing(() => this.limits.clearPlatform(actorOf(req, ip), key));
  }

  @Put('packages/:packageId/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  setPackage(
    @Req() req: Request,
    @Ip() ip: string,
    @Param('packageId', new ParseUUIDPipe()) packageId: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(setLimitSchema)) body: SetLimitInput,
  ) {
    return this.refusing(() => this.limits.setPackage(actorOf(req, ip), packageId, key, body.value));
  }

  @Delete('packages/:packageId/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  clearPackage(@Req() req: Request, @Ip() ip: string, @Param('packageId', new ParseUUIDPipe()) packageId: string, @Param('key') key: string) {
    return this.refusing(() => this.limits.clearPackage(actorOf(req, ip), packageId, key));
  }

  @Put('resellers/:key')
  setResellers(@Req() req: Request, @Ip() ip: string, @Param('key') key: string, @Body(new ZodValidationPipe(setResellersLimitSchema)) body: SetResellersLimitInput) {
    return this.refusing(() => this.limits.setResellers(actorOf(req, ip), key, body.tenantIds, body.value, body.reason));
  }

  @Post('resellers/:key/clear')
  @HttpCode(HttpStatus.OK)
  clearResellers(@Req() req: Request, @Ip() ip: string, @Param('key') key: string, @Body(new ZodValidationPipe(clearResellersLimitSchema)) body: ClearResellersLimitInput) {
    return this.refusing(() => this.limits.clearResellers(actorOf(req, ip), key, body.tenantIds));
  }

  private refusing<T>(work: () => Promise<T>): Promise<T> {
    return refusing(work);
  }
}

/** `ResellerAccess`'s refusals; `read` still admits a suspended reseller. */
const ACCESS_STATUS: Record<ResellerAccessRejection, 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
};

/**
 * One reseller's limits in effect, where each comes from and how much is used
 * (F-019-r, F-019-s): `GET /api/tenants/:id/limits`. No `TenantPermissionGuard`:
 * the reseller's owner holds no `tenant.manage` and is let in by
 * `ResellerAccess`, as its team and the platform's staff are.
 */
@Controller('tenants/:id/limits')
export class ResellerLimitsOfController {
  constructor(private readonly limits: ResellerLimitsService) {}

  @Get()
  async ofReseller(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<LimitInEffectRow[]> {
    const { userId, tenantId, permissions } = identityOf(req);
    try {
      return await this.limits.ofReseller({ userId, tenantId, permissions }, id);
    } catch (e) {
      if (!(e instanceof ResellerAccessRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (ACCESS_STATUS[e.reason]) {
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

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof ResellerLimitsRefused)) throw e;
    const payload = { reason: e.reason, message: e.message };
    switch (STATUS[e.reason]) {
      case 403:
        throw new ForbiddenException(payload);
      case 404:
        throw new NotFoundException(payload);
      default:
        throw new UnprocessableEntityException(payload);
    }
  }
}

function actorOf(req: Request, ip: string): ResellerLimitsActor {
  const { userId, tenantId } = identityOf(req);
  return { adminId: userId, tenantId, ip };
}
