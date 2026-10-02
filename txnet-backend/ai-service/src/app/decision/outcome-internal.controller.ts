import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ok, ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { OutcomeRun, REPORT_MAX_DAYS } from './outcome-run';

const DAY_MS = 86_400_000;
const bodySchema = z
  .object({ tenantId: z.string().uuid(), from: z.coerce.date(), to: z.coerce.date() })
  .refine((b) => b.to > b.from && b.to.getTime() - b.from.getTime() <= REPORT_MAX_DAYS * DAY_MS, { path: ['to'] });

/**
 * The uplift report (F-038-i, ADR-0109 point 13) for the reseller's AI page
 * (F-038-j): per action type, the suggested arm against the holdout over the
 * decisions of `[from, to)`, at most a year. Service callers only, as every
 * route here until ai-service gets a Traefik route; anyone else gets a neutral 404.
 */
@TenantCapability('system')
@Controller('api/internal/ai/reports')
@UseGuards(ServiceOnlyGuard)
export class OutcomeInternalController {
  constructor(private readonly outcomes: OutcomeRun) {}

  @Post('uplift')
  @HttpCode(200)
  async uplift(@Body() body: unknown) {
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.path.join('.')).join(', '));
    const { tenantId, from, to } = parsed.data;
    return ok(await this.outcomes.report(tenantId, from, to));
  }
}
