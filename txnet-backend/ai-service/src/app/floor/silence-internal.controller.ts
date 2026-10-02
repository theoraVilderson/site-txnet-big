import { BadRequestException, Body, Controller, HttpCode, Put, UseGuards } from '@nestjs/common';
import { ok, ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { SilenceSwitch } from './silence';

const bodySchema = z.object({
  tenantId: z.string().uuid().nullable(),
  until: z.string().datetime().nullable(),
});

/**
 * The platform's seam to hush the engine during an outage (F-1548): `tenantId`
 * null is everyone, `until` null lifts it, and an end must be within 7 days.
 * Service callers only — the platform admin page is a row of its own — so a
 * tenant can neither set nor clear it; anyone else gets a neutral 404.
 */
@TenantCapability('system')
@Controller('api/internal/ai')
@UseGuards(ServiceOnlyGuard)
export class SilenceInternalController {
  constructor(private readonly silence: SilenceSwitch) {}

  @Put('silence')
  @HttpCode(200)
  async set(@Body() body: unknown) {
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.path.join('.')).join(', '));
    const { tenantId, until } = parsed.data;
    try {
      await this.silence.set(tenantId, until === null ? null : new Date(until), new Date());
    } catch (err) {
      if (err instanceof Error && err.message === 'until_out_of_range') throw new BadRequestException('until_out_of_range');
      throw err;
    }
    return ok({ tenantId, until });
  }
}
