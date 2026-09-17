import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { toHttp } from '../payment/deposit/deposit.controller';
import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { TenantTopupBody, tenantTopupSchema } from './tenant-topup.schema';
import { TenantTopupRefused, TenantTopupRejection, TenantTopupService, TopupInput } from './tenant-topup.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
export const TENANT_TOPUP_REFUSAL_STATUS: Record<TenantTopupRejection, 403 | 503> = {
  not_a_reseller: 403,
  not_permitted: 403,
  platform_unavailable: 503,
};

function refusal(e: unknown): unknown {
  if (!(e instanceof TenantTopupRefused)) return toHttp(e);
  const payload = { reason: e.reason, message: e.message };
  return TENANT_TOPUP_REFUSAL_STATUS[e.reason] === 403
    ? new ForbiddenException(payload)
    : new ServiceUnavailableException(payload);
}

/**
 * A reseller's billing top-up (F-019-b, D-41, ADR-0056):
 * `GET /api/billing/tenant-wallet/topup/gateways` and
 * `POST /api/billing/tenant-wallet/topup`. Behind the gate; the user and the
 * reseller come from its headers. Limited in the deposit routes' own buckets,
 * per user — the same act, one payment at a bank.
 */
@Controller('billing/tenant-wallet/topup')
export class TenantTopupController {
  constructor(private readonly topups: TenantTopupService) {}

  @Get('gateways')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.DEPOSIT_GATEWAYS, identityOf(req).userId),
    configKey: 'DEPOSIT_GATEWAYS_RATE_LIMIT',
    windowSec: 900,
  })
  async gateways(@Req() req: Request) {
    try {
      return await this.topups.gateways(identityOf(req));
    } catch (e) {
      throw refusal(e);
    }
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.DEPOSIT_START, identityOf(req).userId),
    configKey: 'DEPOSIT_START_RATE_LIMIT',
    windowSec: 900,
  })
  async start(@Body(new ZodValidationPipe(tenantTopupSchema)) body: TenantTopupBody, @Req() req: Request) {
    try {
      // The cast is for this project's non-strict tsconfig, under which zod infers every key as optional.
      return await this.topups.start(identityOf(req), body as TopupInput, req.headers.origin ?? null);
    } catch (e) {
      throw refusal(e);
    }
  }
}
