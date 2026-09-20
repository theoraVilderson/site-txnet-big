import {
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { RevenuePeriodQuery, revenuePeriodSchema } from './reseller-revenue.schema';
import {
  ResellerRevenueRefused,
  ResellerRevenueRejection,
  ResellerRevenueService,
} from './reseller-revenue.service';

/** Every refusal of the door gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ResellerRevenueRejection, 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
};

/**
 * A named reseller's own revenue (F-311-b, ADR-0067):
 * `GET /api/billing/tenants/:tenantId/revenue` — what it sold and what its
 * users paid in, over a period. The figure the bot's management panel shows
 * (F-311-c), and a future panel page with it.
 *
 * **No permission guard**, as on every other reseller-named surface: a
 * reseller's owner holds no operator permission — they are the platform's
 * customer — so `ResellerAccess` is the door, applied inside the service
 * together with the scope the work then runs in.
 *
 * **The tenant is the path's.** The owner signs in to the platform owner's
 * tenant (ADR-0059), so the session's `X-Tenant-Id` would total the platform's
 * own ledgers; `.strict()` on the query refuses a second answer.
 */
@Controller('billing/tenants/:tenantId/revenue')
export class ResellerRevenueController {
  constructor(private readonly revenue: ResellerRevenueService) {}

  @Get()
  @RateLimit({
    key: (req: Request) =>
      rateLimitBucketKey(RateLimitBucket.RESELLER_REVENUE_READ, identityOf(req).userId),
    configKey: 'RESELLER_REVENUE_READ_RATE_LIMIT',
    windowSec: 900,
  })
  async totals(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query(new ZodValidationPipe(revenuePeriodSchema)) period: RevenuePeriodQuery,
    @Req() req: Request,
  ) {
    const { userId, tenantId: actorTenantId, permissions } = identityOf(req);
    try {
      return await this.revenue.totals({ userId, tenantId: actorTenantId, permissions }, tenantId, period);
    } catch (e) {
      if (!(e instanceof ResellerRevenueRefused)) throw e;
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
