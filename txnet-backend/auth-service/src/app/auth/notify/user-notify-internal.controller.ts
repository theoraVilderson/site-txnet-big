import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { ServiceOnlyGuard } from '../../common/guards/service-only.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { NOTIFY_TEMPLATES, NotifyRequest, NotifyResult, UserNotifier } from './user-notifier';

const notifySchema = z
  .object({
    userId: z.string().uuid(),
    template: z.enum(NOTIFY_TEMPLATES),
    params: z.record(z.string().max(200)).default({}),
  })
  .strict();

/**
 * `POST /api/internal/notify/user` (F-067-l, ADR-0045 decision 2) — a service
 * asks for a named message to reach a user on their linked bot. Service callers
 * only (a neutral 404 otherwise); the tenant is `X-Tenant-Id`, bound like the
 * OTP delivery seam's (F-067-a).
 */
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
