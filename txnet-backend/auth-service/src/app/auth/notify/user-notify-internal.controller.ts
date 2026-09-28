import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { TenantCapability } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { ServiceOnlyGuard } from '../../common/guards/service-only.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { NOTIFY_CHANNELS, NOTIFY_TEMPLATES, NotifyRequest, NotifyResult, UserNotifier } from './user-notifier';

const notifySchema = z
  .object({
    userId: z.string().uuid(),
    channel: z.enum(NOTIFY_CHANNELS),
    template: z.enum(NOTIFY_TEMPLATES),
    params: z.record(z.string().max(200)).default({}),
    // F-067-p: a combined burst of this template; absent for one event.
    count: z.number().int().min(2).max(100_000).optional(),
    // F-601-p: the services a combined retention notice is about, listed under it.
    services: z
      .array(
        z
          .object({
            // F-307-x: the buyer's name for the service; absent from an older sender.
            label: z.string().max(40).nullable().optional(),
            nameKey: z.string().max(200).nullable(),
            sku: z.string().max(200).nullable(),
            labels: z.array(z.string().max(40)).max(50),
          })
          .strict(),
      )
      .max(500)
      .optional(),
  })
  .strict();

/**
 * `POST /api/internal/notify/user` (F-067-l, ADR-0045 decision 2) — a service
 * asks for a named message to reach a user through one channel, `inbox` or
 * `bot` (F-067-o). Service callers
 * only (a neutral 404 otherwise); the tenant is `X-Tenant-Id`, bound like the
 * OTP delivery seam's (F-067-a).
 */
@TenantCapability('system')
@Controller('internal/notify')
@UseGuards(ServiceOnlyGuard)
export class UserNotifyInternalController {
  constructor(private readonly notifier: UserNotifier) {}

  @Post('user')
  @HttpCode(HttpStatus.OK)
  async user(@Body(new ZodValidationPipe(notifySchema)) body: NotifyRequest): Promise<NotifyResult> {
    return this.notifier.notify(body);
  }
}
