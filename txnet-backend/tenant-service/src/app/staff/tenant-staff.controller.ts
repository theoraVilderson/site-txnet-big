import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ResellerLimitReached } from '@txnet-backend/shared-core';

import { identityOf } from '../request/identity.middleware';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { InviteStaffInput, inviteStaffSchema } from './tenant-staff.schema';
import { StaffActor, StaffRefused, StaffRejection, StaffView, TenantStaffService } from './tenant-staff.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<StaffRejection, 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  user_not_found: 404,
  user_inactive: 409,
  already_staff: 409,
  expiry_past: 409,
  staff_not_found: 404,
  no_invite: 404,
};

/**
 * A reseller's staff seats (F-018-j): `GET` / `POST /api/tenants/:id/staff`,
 * `POST .../staff/accept` and `DELETE .../staff/:memberId`.
 *
 * No `TenantPermissionGuard`: the reseller's owner holds no `tenant.manage`,
 * and is let in by `ResellerAccess` (F-061-h) — as a member of the reseller who
 * does hold it, and as the platform owner's staff. `accept` is the invitee's
 * own, before any of that admits them.
 */
@Controller('tenants/:id/staff')
export class TenantStaffController {
  constructor(private readonly staff: TenantStaffService) {}

  @Get()
  list(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<StaffView[]> {
    return this.refusing(() => this.staff.list(actorOf(req), id));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  invite(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(inviteStaffSchema)) body: InviteStaffInput,
  ): Promise<StaffView> {
    return this.refusing(() => this.staff.invite(actorOf(req), id, body));
  }

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  accept(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<StaffView> {
    return this.refusing(() => this.staff.accept(actorOf(req), id));
  }

  @Delete(':memberId')
  @HttpCode(HttpStatus.OK)
  remove(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
  ): Promise<StaffView> {
    return this.refusing(() => this.staff.remove(actorOf(req), id, memberId));
  }

  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      // Past the reseller's staff_members_max (F-019-t1): the figures say what to raise.
      if (e instanceof ResellerLimitReached) throw new ConflictException({ reason: e.reason, message: e.message, facts: e.facts });
      if (!(e instanceof StaffRefused)) throw e;
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

function actorOf(req: Request): StaffActor {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions };
}
