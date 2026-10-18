import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { callerOf, refusing } from '../conversations/conversations.controller';
import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { SlaTargetView, SupportSla } from '../sla/sla';
import { SupportAvailability } from './availability';
import { HoursBody, SlaBody, hoursSchema, slaSchema } from './availability.schema';
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

/** A tenant's support settings: weekly hours (F-033-g), SLA targets (F-033-h). `support.manage`, the caller's tenant only. */
@Controller('support/settings')
@UseGuards(SupportManageGuard)
export class SupportSettingsController {
  constructor(
    private readonly availability: SupportAvailability,
    private readonly sla: SupportSla,
  ) {}

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

  /** One row per priority, `urgent` first, each the tenant's own or the platform's (`source`). In working minutes. */
  @Get('sla')
  @RateLimit(READ)
  slaTargets(@Req() req: Request): Promise<SlaTargetView[]> {
    return this.sla.targets(callerOf(req).tenantId);
  }

  @Put('sla')
  @RateLimit(WRITE)
  setSlaTargets(@Req() req: Request, @Body(new ZodValidationPipe(slaSchema)) body: SlaBody): Promise<SlaTargetView[]> {
    return refusing(() => this.sla.setTargets(callerOf(req).tenantId, body.targets));
  }
}
