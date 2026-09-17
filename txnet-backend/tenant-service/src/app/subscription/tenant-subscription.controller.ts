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
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { TenantPermissionGuard } from '../request/tenant-permission.guard';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
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

/**
 * A reseller's package and period, and the platform's trial length (F-018-e):
 * `GET|PUT /api/tenants/:id/subscription`,
 * `POST /api/tenants/:id/subscription/grace` (F-019-g),
 * `GET|PATCH /api/tenant-subscription-settings`.
 *
 * Moved out of `auth-service` with F-018-v (ADR-0058), behaviour unchanged:
 * the paths lost their `/auth` prefix, and the caller is whoever
 * `forward-auth` proved, as on the package routes.
 */
@Controller()
@UseGuards(TenantPermissionGuard)
export class TenantSubscriptionController {
  constructor(private readonly subscriptions: TenantSubscriptionService) {}

  @Put('tenants/:id/subscription')
  async put(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(putSubscriptionSchema)) body: PutSubscriptionInput,
    @Ip() ip: string,
  ): Promise<SubscriptionView> {
    return this.refusing(() => this.subscriptions.put(actorOf(req, ip), id, body));
  }

  @Get('tenants/:id/subscription')
  async read(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string): Promise<SubscriptionView> {
    return this.refusing(() => this.subscriptions.read(actorOf(req, ip), id));
  }

  @Post('tenants/:id/subscription/grace')
  @HttpCode(200)
  async grace(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(grantGraceSchema)) body: GrantGraceInput,
    @Ip() ip: string,
  ): Promise<GraceView> {
    return this.refusing(() => this.subscriptions.grantGrace(actorOf(req, ip), id, body));
  }

  @Get('tenant-subscription-settings')
  async readSettings(@Req() req: Request, @Ip() ip: string): Promise<SubscriptionSettingsView> {
    return this.refusing(() => this.subscriptions.readSettings(actorOf(req, ip)));
  }

  @Patch('tenant-subscription-settings')
  async updateSettings(
    @Req() req: Request,
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

function actorOf(req: Request, ip: string): TenantSubscriptionActor {
  const identity = identityOf(req);
  return { adminId: identity.userId, tenantId: identity.tenantId, ip };
}
