import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { InternalCall, billingInternalCall, postForCounts } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const REPORTS_RUN_PATH = '/api/internal/billing/analytics/reports/run';
const REPORT_COUNTS = ['due', 'sent', 'skipped', 'failed'] as const;

/**
 * The clock on scheduled analytics reports (F-1006-a, billing
 * `contract.analytics-reports.md`). Billing knows each schedule's next run —
 * the person's chosen hour on the tenant's clock — and sends what is due
 * (`AnalyticsReportService.run`); this only asks it often enough.
 *
 * **Every 15 minutes**: a report goes within a quarter hour of its hour, the
 * only hours a person can choose being whole ones.
 *
 * **Safe to run twice** (ADR-0027): each run is claimed on its `nextRunAt`,
 * moved on in the event's transaction — not the clock's doing.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw; a schedule whose send failed is an error of the run.
 */
@Injectable()
export class AnalyticsReportJob implements Job {
  readonly key = 'analytics_report';
  readonly name = 'Scheduled analytics reports';
  readonly description = 'Sends each due scheduled analytics report — daily, weekly or monthly, at its hour in the tenant zone — to its person on the bot or by email (F-1006-a).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, no report goes. Every 15 minutes. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '*/15 * * * *' };

  private readonly logger = new Logger(AnalyticsReportJob.name);
  private readonly call: () => InternalCall;

  constructor(config: ConfigService) {
    this.call = billingInternalCall(config, REPORTS_RUN_PATH);
  }

  async run(): Promise<JobResult> {
    const result = await postForCounts(this.call(), REPORT_COUNTS);
    if (result.sent > 0) this.logger.log(`sent ${result.sent} of ${result.due} due report(s)`);
    return { itemsProcessed: result.sent, errorsCount: result.failed, metrics: { ...result } };
  }
}
