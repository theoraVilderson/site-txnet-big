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
  Query,
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
  GrantGraceInput,
  PutSubscriptionInput,
  UpdateSubscriptionSettingsInput,
  grantGraceSchema,
  putSubscriptionSchema,
  updateSubscriptionSettingsSchema,
} from './tenant-subscription.schema';
import {
  ChangeQuote,
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
  insufficient_balance: 409,
};

/** `ResellerAccess`'s refusals on the reseller's own routes. */
const ACCESS_STATUS: Record<ResellerAccessRejection, 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
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

  private refusing<T>(work: () => Promise<T>): Promise<T> {
    return refusing(work);
  }
}

/**
 * The reseller changes its own package (F-019-v7, ADR-0107 point 9):
 * `GET /api/tenants/:id/subscription/change?packageId&billingModel` answers
 * what it would do — at once and for how much, or at the renewal — and `POST`
 * the same body does it. No `TenantPermissionGuard`: the reseller's owner holds
 * no `tenant.manage` and is let in by `ResellerAccess`, as on its limits.
 */
@Controller('tenants/:id/subscription/change')
export class ResellerSubscriptionChangeController {
  constructor(private readonly subscriptions: TenantSubscriptionService) {}

  @Get()
  quote(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(putSubscriptionSchema)) query: PutSubscriptionInput,
  ): Promise<ChangeQuote> {
    return admitting(() => refusing(() => this.subscriptions.quoteOwn(identityOf(req), id, query)));
  }

  @Post()
  @HttpCode(200)
  change(
    @Req() req: Request,
    @Ip() ip: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(putSubscriptionSchema)) body: PutSubscriptionInput,
  ): Promise<SubscriptionView> {
    return admitting(() => refusing(() => this.subscriptions.changeOwn({ ...identityOf(req), ip }, id, body)));
  }
}

async function admitting<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
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

async function refusing<T>(work: () => Promise<T>): Promise<T> {
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

function actorOf(req: Request, ip: string): TenantSubscriptionActor {
  const identity = identityOf(req);
  return { adminId: identity.userId, tenantId: identity.tenantId, ip };
}
