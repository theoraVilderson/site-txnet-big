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
import { RateLimitBucket, type RateLimitOptions, rateLimitBucketKey, ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import type { RateLimitConfigKey } from '../config/env.validation';
import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
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

/** Both reads scan the reseller's ledgers over the window: one bucket for the pair. */
const READ: RateLimitOptions<RateLimitConfigKey> = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_REVENUE_READ, identityOf(req).userId),
  configKey: 'RESELLER_REVENUE_READ_RATE_LIMIT',
  windowSec: 900,
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
  @RateLimit(READ)
  async totals(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query(new ZodValidationPipe(revenuePeriodSchema)) period: RevenuePeriodQuery,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.revenue.totals(this.actor(req), tenantId, period));
  }

  /**
   * The same sales by product and by day, each cell with its number of people
   * (F-117-h, ADR-0104 (2)(3)). Same door, window and bucket as the totals; a
   * cell under 5 people reads `fewer_than_5` to the platform's staff.
   */
  @Get('breakdown')
  @RateLimit(READ)
  async breakdown(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query(new ZodValidationPipe(revenuePeriodSchema)) period: RevenuePeriodQuery,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.revenue.breakdown(this.actor(req), tenantId, period));
  }

  private actor(req: Request) {
    const { userId, tenantId, permissions } = identityOf(req);
    return { userId, tenantId, permissions };
  }

  /** The door's refusal, one status per reason; anything else is not this surface's to translate. */
  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
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
