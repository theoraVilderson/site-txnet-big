import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { PurchaseInput, SuggestSlugInput, purchaseSchema, suggestSlugSchema } from './reseller-purchase.schema';
import {
  PackageOffer,
  PurchaseBuyer,
  PurchaseRejection,
  PurchaseView,
  ResellerPurchaseRefused,
  ResellerPurchaseService,
} from './reseller-purchase.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<PurchaseRejection, 403 | 404 | 409 | 422> = {
  not_platform_user: 403,
  package_not_found: 404,
  buyer_inactive: 409,
  already_reseller: 409,
  slug_taken: 409,
  insufficient_balance: 409,
  wallet_changed: 409,
  package_inactive: 422,
  package_not_sold_for_period: 422,
};

/** Per user: the package list and the slug suggestion share one budget, a purchase has its own (15 minutes each). */
const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_PURCHASE_READ, identityOf(req).userId),
  configKey: 'RESELLER_PURCHASE_READ_RATE_LIMIT' as const,
  windowSec: 900,
};
const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_PURCHASE_WRITE, identityOf(req).userId),
  configKey: 'RESELLER_PURCHASE_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * A platform user buys a reseller (F-019-h, ADR-0061):
 * `GET /api/tenants/purchase/packages`, `GET /api/tenants/purchase/slug?name=`,
 * `POST /api/tenants/purchase`.
 *
 * No permission key: any signed-in user of the platform owner's tenant may
 * buy, and that is the service's check. `forward-auth` proved the caller.
 */
@Controller('tenants/purchase')
export class ResellerPurchaseController {
  constructor(private readonly purchases: ResellerPurchaseService) {}

  @Get('packages')
  @RateLimit(READ)
  async packages(@Req() req: Request, @Ip() ip: string): Promise<PackageOffer[]> {
    return this.refusing(() => this.purchases.packages(buyerOf(req, ip)));
  }

  @Get('slug')
  @RateLimit(READ)
  async slug(@Req() req: Request, @Query(new ZodValidationPipe(suggestSlugSchema)) query: SuggestSlugInput, @Ip() ip: string): Promise<{ slug: string }> {
    return this.refusing(() => this.purchases.suggestSlug(buyerOf(req, ip), query.name));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async purchase(@Req() req: Request, @Body(new ZodValidationPipe(purchaseSchema)) body: PurchaseInput, @Ip() ip: string): Promise<PurchaseView> {
    return this.refusing(() => this.purchases.purchase(buyerOf(req, ip), body));
  }

  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (!(e instanceof ResellerPurchaseRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (STATUS[e.reason]) {
        case 403:
          throw new ForbiddenException(payload);
        case 404:
          throw new NotFoundException(payload);
        case 422:
          throw new UnprocessableEntityException(payload);
        default:
          throw new ConflictException(payload);
      }
    }
  }
}

function buyerOf(req: Request, ip: string): PurchaseBuyer {
  const identity = identityOf(req);
  return { userId: identity.userId, tenantId: identity.tenantId, ip };
}
