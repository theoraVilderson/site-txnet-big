import { BadRequestException, Body, Controller, HttpCode, Put, UseGuards } from '@nestjs/common';
import { AiActionType } from '@prisma/client';
import { ok, ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { TypeSwitch } from './type-switch';

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  disabledActionTypes: z.array(z.nativeEnum(AiActionType)),
  updatedByUserId: z.string().uuid(),
});

/**
 * The seam the reseller's AI settings (F-038-j) reach to switch action types
 * off (F-1509): the whole list, replaced. The caller has already checked the
 * admin may change the tenant's settings and passes who did. Service callers
 * only, as every route here until ai-service gets a Traefik route; anyone else
 * gets a neutral 404.
 */
@TenantCapability('system')
@Controller('api/internal/ai/settings')
@UseGuards(ServiceOnlyGuard)
export class TypeSwitchInternalController {
  constructor(private readonly types: TypeSwitch) {}

  @Put('disabled-action-types')
  @HttpCode(200)
  async set(@Body() body: unknown) {
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.path.join('.')).join(', '));
    const { tenantId, disabledActionTypes, updatedByUserId } = parsed.data;
    await this.types.set(tenantId, disabledActionTypes, updatedByUserId);
    return ok({ disabledActionTypes: [...new Set(disabledActionTypes)] });
  }
}
