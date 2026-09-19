import {
  BadRequestException,
  Body,
  CanActivate,
  ConflictException,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, holdsPermission, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { AdjustBody, adjustSchema } from './tenant-billing-admin.schema';
import {
  AdjustInput,
  TenantBillingAdminRefused,
  TenantBillingAdminRejection,
  TenantBillingAdminService,
} from './tenant-billing-admin.service';
import { TenantWalletQueryBody, tenantWalletSchema } from './tenant-wallet.schema';

/**
 * The permission a manual adjustment needs (F-019-a). Granted to `Admin`, as
 * `payment.confirm_manual` is; the service admits only the platform owner's.
 */
export const TENANT_BILLING_ADJUST = 'tenant_billing.adjust';

/**
 * The permission the owner's read of a reseller's ledger needs (F-019-j).
 * Separate from {@link TENANT_BILLING_ADJUST}, and granted to `Admin` beside
 * it: seeing what the platform charged a reseller is not moving its balance,
 * so a role may later hold one without the other. Either way the service's
 * owner check is the boundary.
 */
export const TENANT_BILLING_READ = 'tenant_billing.read';

/** The first door of either route; the platform-owner check in the service is the real one. */
function demand(req: Request, permission: string): boolean {
  if (!holdsPermission(identityOf(req).permissions, permission)) {
    throw new ForbiddenException(`${permission} is required`);
  }
  return true;
}

@Injectable()
export class TenantBillingPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return demand(context.switchToHttp().getRequest<Request>(), TENANT_BILLING_ADJUST);
  }
}

@Injectable()
export class TenantBillingReadGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return demand(context.switchToHttp().getRequest<Request>(), TENANT_BILLING_READ);
  }
}

/** Every refusal gets a status; a new reason does not compile until it gets one. */
export const TENANT_BILLING_REFUSAL_STATUS: Record<TenantBillingAdminRejection, 400 | 403 | 404 | 409> = {
  not_platform_owner: 403,
  tenant_not_found: 404,
  not_a_reseller: 400,
  invalid_amount: 400,
  insufficient_balance: 409,
  duplicate_request: 409,
  wallet_changed: 409,
};

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.WALLET_HISTORY, identityOf(req).userId),
  configKey: 'WALLET_HISTORY_RATE_LIMIT' as const,
  windowSec: 900,
};

const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.TENANT_BILLING_ADMIN_WRITE, identityOf(req).userId),
  configKey: 'TENANT_BILLING_ADMIN_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * One reseller's billing wallet, in the platform owner's hands (D-41):
 * adjusted at `POST /api/billing/tenant-wallets/:tenantId/adjustments`
 * (F-019-a) and read at `GET /api/billing/tenant-wallets/:tenantId/transactions`
 * (F-019-j). Each route carries its own permission, so the guard is on the
 * method rather than the class.
 */
@Controller('billing/tenant-wallets')
export class TenantBillingAdminController {
  constructor(private readonly billing: TenantBillingAdminService) {}

  /** The owner's page of one reseller's ledger: the balance and its movements, newest first. */
  @Get(':tenantId/transactions')
  @UseGuards(TenantBillingReadGuard)
  @RateLimit(READ)
  async transactions(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query(new ZodValidationPipe(tenantWalletSchema)) query: TenantWalletQueryBody,
    @Req() req: Request,
  ) {
    const { userId, tenantId: callerTenant } = identityOf(req);
    try {
      return await this.billing.history({ adminId: userId, tenantId: callerTenant }, tenantId, query);
    } catch (e) {
      throw refusalOf(e);
    }
  }

  @Post(':tenantId/adjustments')
  @UseGuards(TenantBillingPermissionGuard)
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async adjust(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(adjustSchema)) body: AdjustBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const { userId, tenantId: callerTenant } = identityOf(req);
    try {
      // The cast is for this project's non-strict tsconfig, under which zod infers every key as optional.
      return await this.billing.adjust({ adminId: userId, tenantId: callerTenant, ip }, tenantId, body as AdjustInput);
    } catch (e) {
      throw refusalOf(e);
    }
  }
}

/** A refusal becomes its status; anything else is left alone. */
function refusalOf(e: unknown): unknown {
  if (!(e instanceof TenantBillingAdminRefused)) return e;
  const payload = { reason: e.reason, message: e.message };
  switch (TENANT_BILLING_REFUSAL_STATUS[e.reason]) {
    case 403:
      return new ForbiddenException(payload);
    case 404:
      return new NotFoundException(payload);
    case 409:
      return new ConflictException(payload);
    default:
      return new BadRequestException(payload);
  }
}
