import {
  BadRequestException,
  Body,
  CanActivate,
  ConflictException,
  Controller,
  ExecutionContext,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Injectable,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
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

/**
 * The permission a manual adjustment needs (F-019-a). Granted to `Admin`, as
 * `payment.confirm_manual` is; the service admits only the platform owner's.
 */
export const TENANT_BILLING_ADJUST = 'tenant_billing.adjust';

/** The first door; the platform-owner check in the service is the real one. */
@Injectable()
export class TenantBillingPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!holdsPermission(identityOf(req).permissions, TENANT_BILLING_ADJUST)) {
      throw new ForbiddenException(`${TENANT_BILLING_ADJUST} is required`);
    }
    return true;
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

const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.TENANT_BILLING_ADMIN_WRITE, identityOf(req).userId),
  configKey: 'TENANT_BILLING_ADMIN_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * A reseller's billing wallet, adjusted by the platform owner (F-019-a, D-41):
 * `POST /api/billing/tenant-wallets/:tenantId/adjustments`.
 */
@Controller('billing/tenant-wallets')
@UseGuards(TenantBillingPermissionGuard)
export class TenantBillingAdminController {
  constructor(private readonly billing: TenantBillingAdminService) {}

  @Post(':tenantId/adjustments')
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
      if (!(e instanceof TenantBillingAdminRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (TENANT_BILLING_REFUSAL_STATUS[e.reason]) {
        case 403:
          throw new ForbiddenException(payload);
        case 404:
          throw new NotFoundException(payload);
        case 409:
          throw new ConflictException(payload);
        default:
          throw new BadRequestException(payload);
      }
    }
  }
}
