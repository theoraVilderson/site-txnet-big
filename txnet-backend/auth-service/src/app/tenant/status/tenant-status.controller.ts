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
import { AuthGuard } from '../../auth/auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PermissionsGuard } from '../../impersonation/guards/permissions.guard';
import { TENANT_MANAGE } from '../admin/tenant-admin.controller';
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

type ClaimsRequest = { user: { sub: string; tenantId: string } };

/**
 * A reseller's status (F-018-f): `PUT /api/auth/tenants/:id/status`,
 * `GET /api/auth/tenants/:id/status-history`.
 */
@Controller('auth/tenants')
@UseGuards(AuthGuard, new PermissionsGuard([TENANT_MANAGE]))
export class TenantStatusController {
  constructor(private readonly statuses: TenantStatusService) {}

  @Put(':id/status')
  async change(
    @Req() req: ClaimsRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(changeTenantStatusSchema)) body: ChangeTenantStatusInput,
    @Ip() ip: string,
  ): Promise<TenantStatusView> {
    return this.refusing(() => this.statuses.change(actorOf(req, ip), id, body));
  }

  @Get(':id/status-history')
  async history(@Req() req: ClaimsRequest, @Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string): Promise<TenantStatusHistoryView[]> {
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

function actorOf(req: ClaimsRequest, ip: string): TenantStatusActor {
  return { adminId: req.user.sub, tenantId: req.user.tenantId, ip };
}
