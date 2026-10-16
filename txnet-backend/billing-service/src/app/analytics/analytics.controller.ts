import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { RateLimitBucket, type RateLimitOptions, ResellerAccessRejection, rateLimitBucketKey, requestLanguage } from '@txnet-backend/shared-core';
import type { Request, Response } from 'express';

import type { RateLimitConfigKey } from '../config/env.validation';
import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { RefusalStatus, refusalException } from '../request/refusal-exception';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { LocaleService } from '../locale/locale.service';
import { AnalyticsExportService, AnalyticsRebuilding } from './analytics-export.service';
import { RenewalWindowBody, renewalWindowSchema } from './analytics-settings';
import { AnalyticsSettingsService } from './analytics-settings.service';
import { AnalyticsAnswer, AnalyticsRefused, AnalyticsService } from './analytics.service';
import { AnalyticsRequest, AnalyticsTab, analyticsRequestSchema } from './analytics.schema';

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
 * `format=csv|xlsx` answers the same figures as a file (F-1007-a, "Export").
 */
@Controller('billing/tenants/:tenantId/analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly files: AnalyticsExportService,
    private readonly locale: LocaleService,
    private readonly settings: AnalyticsSettingsService,
  ) {}

  /** KPIs against the previous window, the hero series, sales by product, the calendar. */
  @Get('overview')
  @RateLimit(READ)
  overview(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Query(new ZodValidationPipe(analyticsRequestSchema)) q: AnalyticsRequest, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.read(req, res, tenantId, 'overview', q);
  }

  /** Package and usage sales, payments by gateway, discounts, gifts, refunds by product. */
  @Get('sales')
  @RateLimit(READ)
  sales(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Query(new ZodValidationPipe(analyticsRequestSchema)) q: AnalyticsRequest, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.read(req, res, tenantId, 'sales', q);
  }

  /** Per product and per panel: net, orders, buyers, bytes, share and a sparkline. */
  @Get('catalog')
  @RateLimit(READ)
  catalog(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Query(new ZodValidationPipe(analyticsRequestSchema)) q: AnalyticsRequest, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.read(req, res, tenantId, 'catalog', q);
  }

  /** New vs returning, signups -> first purchase, renewal by product, top customers (F-1001-f). */
  @Get('customers')
  @RateLimit(READ)
  customers(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Query(new ZodValidationPipe(analyticsRequestSchema)) q: AnalyticsRequest, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.read(req, res, tenantId, 'customers', q);
  }

  /** The platform's own: every reseller's net, delta, top-ups, buyers, services and sparkline, tier A (F-1001-h). */
  @Get('resellers')
  @RateLimit(READ)
  resellers(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Query(new ZodValidationPipe(analyticsRequestSchema)) q: AnalyticsRequest, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.read(req, res, tenantId, 'resellers', q);
  }

  /** The renewal window, 1..30 days (F-1001-f) — the settings key's, not `analytics.read`'s. Rare: the read bucket bounds it. */
  @Put('settings')
  @RateLimit(READ)
  async setSettings(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(renewalWindowSchema)) body: RenewalWindowBody, @Req() req: Request) {
    const { userId, tenantId: sessionTenantId, permissions } = identityOf(req);
    try {
      return await this.settings.setRenewalWindow({ userId, tenantId: sessionTenantId, permissions }, tenantId, body);
    } catch (e) {
      if (!(e instanceof AnalyticsRefused)) throw e;
      throw refusalException(STATUS[e.reason], { reason: e.reason, message: e.message });
    }
  }

  private async read(req: Request, res: Response, tenantId: string, tab: AnalyticsTab, { format, ...q }: AnalyticsRequest): Promise<AnalyticsAnswer | StreamableFile> {
    const { userId, tenantId: sessionTenantId, permissions } = identityOf(req);
    const actor = { userId, tenantId: sessionTenantId, permissions };
    try {
      if (!format) return await this.analytics.read(actor, tenantId, tab, q);
      const file = await this.files.file(actor, tenantId, tab, q, format, requestLanguage(req, this.locale));
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
      return new StreamableFile(file.body);
    } catch (e) {
      // Half-built figures are never a file (principle 5); the page shows its own alert instead.
      if (e instanceof AnalyticsRebuilding) throw refusalException(409, { reason: 'rebuilding', message: e.message });
      if (!(e instanceof AnalyticsRefused)) throw e;
      throw refusalException(STATUS[e.reason], { reason: e.reason, message: e.message });
    }
  }
}
