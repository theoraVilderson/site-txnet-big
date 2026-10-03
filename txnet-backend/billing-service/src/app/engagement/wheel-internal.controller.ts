import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { WheelSpinService, type WheelInviteCheck } from './wheel-spin.service';

export const inviteCheckSchema = z.object({ tenantId: z.string().uuid(), userId: z.string().uuid() }).strict();
type InviteCheckBody = z.infer<typeof inviteCheckSchema>;

/**
 * The seam `worker-service` asks the wheel through when it delivers an AI
 * `wheel_invite` (F-038-u): may this user spin now. Outside the gate and the
 * tenant, as `lottery-internal.controller.ts`: `ServiceOnlyGuard`, the tenant
 * named in the body. The usual envelope.
 */
@TenantCapability('system')
@Controller('internal/billing/engagement/wheel')
@UseGuards(ServiceOnlyGuard)
export class WheelInternalController {
  constructor(private readonly wheel: WheelSpinService) {}

  @Post('invite-check')
  @HttpCode(200)
  inviteCheck(@Body(new ZodValidationPipe(inviteCheckSchema)) body: InviteCheckBody): Promise<WheelInviteCheck> {
    return this.wheel.inviteCheck({ tenantId: body.tenantId, userId: body.userId });
  }
}
