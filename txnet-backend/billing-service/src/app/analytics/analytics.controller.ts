import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { RateLimitBucket, type RateLimitOptions, ResellerAccessRejection, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import type { RateLimitConfigKey } from '../config/env.validation';
import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { RefusalStatus, refusalException } from '../request/refusal-exception';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { AnalyticsAnswer, AnalyticsRefused, AnalyticsService } from './analytics.service';
import { AnalyticsQuery, AnalyticsTab, analyticsQuerySchema } from './analytics.schema';

/** Every refusal of the door gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ResellerAccessRejection, RefusalStatus> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
};

/** Every tab sums the rollup over its window and the compared one: one bucket for all of them. */
const READ: RateLimitOptions<RateLimitConfigKey> = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.ANALYTICS_READ, identityOf(req).userId),
  configKey: 'ANALYTICS_READ_RATE_LIMIT',
  windowSec: 900,
};

/**
 * A tenant's analytics (F-1001-b, billing/contract.analytics.md "Read routes"):
 * `GET /api/billing/tenants/:tenantId/analytics/<tab>`, one request per tab.
 *
 * **No permission guard**, as on every reseller-named surface: the reseller's
 * owner holds no operator key, so `ResellerAccess` with `analytics.read` is
 * the door, applied in the service with the scope the read runs in. **The
 * tenant is the path's**; `.strict()` on the query refuses a second answer.
 */
@Controller('billing/tenants/:tenantId/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** KPIs against the previous window, the hero series, sales by product, the calendar. */
  @Get('overview')
  @RateLimit(READ)
  overview(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Query(new ZodValidationPipe(analyticsQuerySchema)) q: AnalyticsQuery, @Req() req: Request) {
    return this.read(req, tenantId, 'overview', q);
  }

  /** Package and usage sales, payments by gateway, discounts, gifts, refunds by product. */
  @Get('sales')
  @RateLimit(READ)
  sales(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Query(new ZodValidationPipe(analyticsQuerySchema)) q: AnalyticsQuery, @Req() req: Request) {
    return this.read(req, tenantId, 'sales', q);
  }

  /** Per product and per panel: net, orders, buyers, bytes, share and a sparkline. */
  @Get('catalog')
  @RateLimit(READ)
  catalog(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Query(new ZodValidationPipe(analyticsQuerySchema)) q: AnalyticsQuery, @Req() req: Request) {
    return this.read(req, tenantId, 'catalog', q);
  }

  private async read(req: Request, tenantId: string, tab: AnalyticsTab, q: AnalyticsQuery): Promise<AnalyticsAnswer> {
    const { userId, tenantId: sessionTenantId, permissions } = identityOf(req);
    try {
      return await this.analytics.read({ userId, tenantId: sessionTenantId, permissions }, tenantId, tab, q);
    } catch (e) {
      if (!(e instanceof AnalyticsRefused)) throw e;
      throw refusalException(STATUS[e.reason], { reason: e.reason, message: e.message });
    }
  }
}
