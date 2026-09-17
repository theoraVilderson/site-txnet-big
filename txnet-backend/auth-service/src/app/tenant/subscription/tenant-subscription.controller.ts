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
  HttpCode,
  Patch,
  Post,
  Put,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PermissionsGuard } from '../../impersonation/guards/permissions.guard';
import { TENANT_MANAGE } from '../admin/tenant-admin.controller';
import {
  GrantGraceInput,
  PutSubscriptionInput,
  UpdateSubscriptionSettingsInput,
  grantGraceSchema,
  putSubscriptionSchema,
  updateSubscriptionSettingsSchema,
} from './tenant-subscription.schema';
import {
  GraceView,
  SubscriptionSettingsView,
  SubscriptionView,
  TenantSubscriptionActor,
  TenantSubscriptionRefused,
  TenantSubscriptionRejection,
  TenantSubscriptionService,
} from './tenant-subscription.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<TenantSubscriptionRejection, 403 | 404 | 409 | 422> = {
  not_platform_owner: 403,
  reseller_not_found: 404,
  subscription_not_found: 404,
  package_not_found: 404,
  reseller_terminated: 409,
  package_inactive: 422,
  package_not_sold_for_period: 422,
};

type ClaimsRequest = { user: { sub: string; tenantId: string } };

/**
 * A reseller's package and period, and the platform's trial length (F-018-e):
 * `GET|PUT /api/auth/tenants/:id/subscription`,
 * `POST /api/auth/tenants/:id/subscription/grace` (F-019-g),
 * `GET|PATCH /api/auth/tenant-subscription-settings`.
 */
@Controller('auth')
@UseGuards(AuthGuard, new PermissionsGuard([TENANT_MANAGE]))
export class TenantSubscriptionController {
  constructor(private readonly subscriptions: TenantSubscriptionService) {}

  @Put('tenants/:id/subscription')
  async put(
    @Req() req: ClaimsRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(putSubscriptionSchema)) body: PutSubscriptionInput,
    @Ip() ip: string,
  ): Promise<SubscriptionView> {
    return this.refusing(() => this.subscriptions.put(actorOf(req, ip), id, body));
  }

  @Get('tenants/:id/subscription')
  async read(@Req() req: ClaimsRequest, @Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string): Promise<SubscriptionView> {
    return this.refusing(() => this.subscriptions.read(actorOf(req, ip), id));
  }

  @Post('tenants/:id/subscription/grace')
  @HttpCode(200)
  async grace(
    @Req() req: ClaimsRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(grantGraceSchema)) body: GrantGraceInput,
    @Ip() ip: string,
  ): Promise<GraceView> {
    return this.refusing(() => this.subscriptions.grantGrace(actorOf(req, ip), id, body));
  }

  @Get('tenant-subscription-settings')
  async readSettings(@Req() req: ClaimsRequest, @Ip() ip: string): Promise<SubscriptionSettingsView> {
    return this.refusing(() => this.subscriptions.readSettings(actorOf(req, ip)));
  }

  @Patch('tenant-subscription-settings')
  async updateSettings(
    @Req() req: ClaimsRequest,
    @Body(new ZodValidationPipe(updateSubscriptionSettingsSchema)) body: UpdateSubscriptionSettingsInput,
    @Ip() ip: string,
  ): Promise<SubscriptionSettingsView> {
    return this.refusing(() => this.subscriptions.updateSettings(actorOf(req, ip), body));
  }

  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (!(e instanceof TenantSubscriptionRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (STATUS[e.reason]) {
        case 403:
          throw new ForbiddenException(payload);
        case 404:
          throw new NotFoundException(payload);
        case 409:
          throw new ConflictException(payload);
        default:
          throw new UnprocessableEntityException(payload);
      }
    }
  }
}

function actorOf(req: ClaimsRequest, ip: string): TenantSubscriptionActor {
  return { adminId: req.user.sub, tenantId: req.user.tenantId, ip };
}
