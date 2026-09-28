import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { NoticeSms, NoticeSmsAnswer, NoticeSmsService } from './notice-sms';

const noticeSmsSchema = z
  .object({
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    to: z.string().min(5).max(20),
    text: z.string().min(1).max(2000),
  })
  .strict();

/**
 * `POST /api/internal/notifications/sms` (F-601-t) — auth-service's `sms`
 * channel of `/internal/notify/user` asks for one notice's SMS on the
 * recipient tenant's line. Processes only (`SERVICE_AUTH_TOKEN`, ADR-0011);
 * not routed by Traefik; a wrong token is a 404. No rate limit, for the
 * reason `notification-internal.controller.ts` gives. The tenant is in the
 * body: an internal call carries no identity headers here.
 */
@Controller('internal/notifications/sms')
@UseGuards(ServiceOnlyGuard)
export class NoticeSmsController {
  constructor(private readonly sms: NoticeSmsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  send(@Body(new ZodValidationPipe(noticeSmsSchema)) body: NoticeSms): Promise<NoticeSmsAnswer> {
    return this.sms.send(body);
  }
}
