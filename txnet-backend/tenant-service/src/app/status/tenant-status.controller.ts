import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { TenantPermissionGuard } from '../request/tenant-permission.guard';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { ChangeTenantStatusInput, changeTenantStatusSchema } from './tenant-status.schema';
import {
  TenantStatusActor,
  TenantStatusHistoryView,
  TenantStatusRefused,
  TenantStatusRejection,
  TenantStatusService,
  TenantStatusView,
} from './tenant-status.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<TenantStatusRejection, 403 | 404 | 409> = {
  not_platform_owner: 403,
  reseller_not_found: 404,
  reseller_terminated: 409,
  status_unchanged: 409,
};

/**
 * A reseller's status (F-018-f): `PUT /api/tenants/:id/status`,
 * `GET /api/tenants/:id/status-history`.
 *
 * Moved out of `auth-service` with F-018-w (ADR-0058), behaviour unchanged but
 * for `stopCampaigns`, which left with the outbox path it wrote: the paths lost
 * their `/auth` prefix, and the caller is whoever `forward-auth` proved, as on
 * the subscription routes.
 */
@Controller()
@UseGuards(TenantPermissionGuard)
export class TenantStatusController {
  constructor(private readonly statuses: TenantStatusService) {}

  @Put('tenants/:id/status')
  async change(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(changeTenantStatusSchema)) body: ChangeTenantStatusInput,
    @Ip() ip: string,
  ): Promise<TenantStatusView> {
    return this.refusing(() => this.statuses.change(actorOf(req, ip), id, body));
  }

  @Get('tenants/:id/status-history')
  async history(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string): Promise<TenantStatusHistoryView[]> {
    return this.refusing(() => this.statuses.history(actorOf(req, ip), id));
  }

  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (!(e instanceof TenantStatusRefused)) throw e;
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

function actorOf(req: Request, ip: string): TenantStatusActor {
  const identity = identityOf(req);
  return { adminId: identity.userId, tenantId: identity.tenantId, ip };
}
