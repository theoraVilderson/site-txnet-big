import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { RefusalStatus, refusalException } from '../request/refusal-exception';
import { ZodValidationPipe } from '@txnet-backend/shared-core';
import { ReportScheduleBody, ReportScheduleChange, reportScheduleChangeSchema, reportScheduleSchema } from './analytics-reports.schema';
import { AnalyticsReportService, ReportRefusal, ReportRefused } from './analytics-reports.service';
import { READ } from './analytics.controller';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ReportRefusal, RefusalStatus> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  not_found: 404,
  too_many_schedules: 409,
  rebuilding: 409,
};

/**
 * A person's scheduled reports (F-1006-a, contract.analytics-reports.md
 * "Routes"): `/api/billing/tenants/:tenantId/analytics/report-schedules`,
 * beside the tabs and behind the same door (`analytics.read`, in the
 * service). Rare and personal: the analytics read bucket bounds them.
 */
@Controller('billing/tenants/:tenantId/analytics/report-schedules')
export class AnalyticsReportsController {
  constructor(private readonly reports: AnalyticsReportService) {}

  @Get()
  @RateLimit(READ)
  list(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request) {
    return refusing(() => this.reports.list(actorOf(req), tenantId));
  }

  @Post()
  @RateLimit(READ)
  create(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(reportScheduleSchema)) body: ReportScheduleBody, @Req() req: Request) {
    return refusing(() => this.reports.create(actorOf(req), tenantId, body));
  }

  @Patch(':id')
  @RateLimit(READ)
  change(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(reportScheduleChangeSchema)) body: ReportScheduleChange,
    @Req() req: Request,
  ) {
    return refusing(() => this.reports.change(actorOf(req), tenantId, id, body));
  }

  @Delete(':id')
  @RateLimit(READ)
  remove(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.reports.remove(actorOf(req), tenantId, id));
  }

  /** The period that closed before now, sent at once to the caller's own schedule (F-1006-b's "send now"). */
  @Post(':id/send')
  @HttpCode(200)
  @RateLimit(READ)
  send(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.reports.sendNow(actorOf(req), tenantId, id));
  }
}

const actorOf = (req: Request) => {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions };
};

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof ReportRefused)) throw e;
    throw refusalException(STATUS[e.reason], { reason: e.reason, message: e.message });
  }
}
