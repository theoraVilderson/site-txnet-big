import { Body, Controller, ForbiddenException, Get, HttpException, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { SetTenantTimeZoneInput, setTenantTimeZoneSchema } from './tenant-time-zone.schema';
import { TenantTimeZoneRefused, TenantTimeZoneRejection, TenantTimeZoneService, TenantTimeZoneView } from './tenant-time-zone.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<TenantTimeZoneRejection, 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_suspended: 403,
  reseller_not_found: 404,
  reseller_terminated: 409,
};

/**
 * A tenant's time zone (TZ-1-d, ADR-0108 point 7):
 * `GET` / `PUT /api/tenants/:id/timezone`. `:id` is a reseller, or the
 * platform owner's own tenant for its staff.
 *
 * No `TenantPermissionGuard`: a reseller's owner holds no `tenant.manage`; the
 * service admits (`ResellerAccess`, or the platform's own staff).
 */
@Controller('tenants/:id/timezone')
export class TenantTimeZoneController {
  constructor(private readonly zones: TenantTimeZoneService) {}

  @Get()
  read(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<TenantTimeZoneView> {
    return refusing(() => this.zones.read(actorOf(req), id));
  }

  @Put()
  set(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setTenantTimeZoneSchema)) body: SetTenantTimeZoneInput,
  ): Promise<TenantTimeZoneView> {
    return refusing(() => this.zones.set(actorOf(req), id, body.zone));
  }
}

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof TenantTimeZoneRefused)) throw e;
    const payload = { reason: e.reason, message: e.message };
    switch (STATUS[e.reason]) {
      case 403:
        throw new ForbiddenException(payload);
      case 404:
        throw new NotFoundException(payload);
      default:
        throw new HttpException(payload, HttpStatus.CONFLICT);
    }
  }
}

function actorOf(req: Request) {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions };
}
