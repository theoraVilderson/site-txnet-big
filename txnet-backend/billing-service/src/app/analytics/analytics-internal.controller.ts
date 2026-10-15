import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { AnalyticsRefreshResult, AnalyticsRollupService } from './analytics-rollup.service';

const rebuildSchema = z.object({ tenantId: z.string().uuid() }).strict();
type RebuildBody = z.infer<typeof rebuildSchema>;

/**
 * The seam `worker-service` reaches the analytics rollup through (F-1001-a),
 * as `deposit-internal.controller.ts` is for the expiry sweep: the worker owns
 * *when*, billing owns *what*. Outside the gate and outside the tenant —
 * `ServiceOnlyGuard` stands in for both, refused as a neutral 404.
 */
@TenantCapability('system')
@Controller('internal/billing/analytics')
@UseGuards(ServiceOnlyGuard)
export class AnalyticsInternalController {
  constructor(private readonly rollup: AnalyticsRollupService) {}

  /** The 5-minute tick: today and yesterday of each tenant due, or a whole rebuild where the zone moved. */
  @Post('refresh')
  @HttpCode(200)
  refresh(): Promise<AnalyticsRefreshResult> {
    return this.rollup.refresh();
  }

  /** One tenant's whole history again — after a fixed rollup bug (billing/contract.analytics.md "The worker"). */
  @Post('rebuild')
  @HttpCode(200)
  async rebuild(@Body(new ZodValidationPipe(rebuildSchema)) body: RebuildBody): Promise<{ changed: boolean }> {
    return { changed: await this.rollup.rebuild(body.tenantId) };
  }
}
