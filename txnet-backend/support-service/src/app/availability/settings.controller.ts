import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { callerOf, refusing } from '../conversations/conversations.controller';
import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { SupportAvailability } from './availability';
import { HoursBody, hoursSchema } from './availability.schema';
import { SupportManageGuard } from './support-manage.guard';
import type { WorkingHours } from './working-hours';

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SUPPORT_READ, identityOf(req).userId),
  configKey: 'SUPPORT_READ_RATE_LIMIT' as const,
  windowSec: 60,
};

const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SUPPORT_SEND, identityOf(req).userId),
  configKey: 'SUPPORT_SEND_RATE_LIMIT' as const,
  windowSec: 60,
};

/** A tenant's support settings (F-033-g): its weekly hours. `support.manage`, the caller's tenant only. */
@Controller('support/settings')
@UseGuards(SupportManageGuard)
export class SupportSettingsController {
  constructor(private readonly availability: SupportAvailability) {}

  /** `{zone, intervals: [{weekday, startMinute, endMinute}]}` — `zone` is the tenant's, set elsewhere (ADR-0108). */
  @Get('hours')
  @RateLimit(READ)
  hours(@Req() req: Request): Promise<WorkingHours> {
    return this.availability.hours(callerOf(req).tenantId);
  }

  @Put('hours')
  @RateLimit(WRITE)
  setHours(@Req() req: Request, @Body(new ZodValidationPipe(hoursSchema)) body: HoursBody): Promise<WorkingHours> {
    return refusing(() => this.availability.setHours(callerOf(req).tenantId, body.intervals));
  }
}
