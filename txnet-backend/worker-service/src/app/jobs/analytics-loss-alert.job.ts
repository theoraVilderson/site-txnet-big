import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { InternalCall, billingInternalCall, postForCounts } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const LOSS_ALERTS_PATH = '/api/internal/billing/analytics/loss-alerts';
const LOSS_COUNTS = ['tenants', 'told', 'failed'] as const;

/**
 * The clock on "this user costs more than they pay" (F-1003, billing
 * `contract.analytics-tabs.md` "Loss alert"). Billing judges and emits one
 * `billing.analytics.user_loss` per staff member (`analytics-loss.ts`); the
 * owner-notice consumer tells. The clock is this service's, over the internal
 * seam, as `analytics-rollup.job.ts` is.
 *
 * **Daily**: a 30-day figure moves slowly, and a user is told about once a
 * month at most. 05:30 UTC, morning in the platform's zone.
 *
 * **Safe to run twice** (ADR-0027): the claim per user and tenant month is
 * what keeps a second run silent, not the clock.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw; a tenant whose pass failed is an error of the run.
 */
@Injectable()
export class AnalyticsLossAlertJob implements Job {
  readonly key = 'analytics_loss_alert';
  readonly name = 'Users costing more than they pay';
  readonly description =
    "Tells each tenant's staff, once a month per user, about a user whose last 30 days cost more than they paid by more than the tenant's percent (F-1003).";
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, nobody is told. Daily at 05:30 UTC. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '30 5 * * *' };

  private readonly logger = new Logger(AnalyticsLossAlertJob.name);
  private readonly call: () => InternalCall;

  constructor(config: ConfigService) {
    this.call = billingInternalCall(config, LOSS_ALERTS_PATH);
  }

  async run(): Promise<JobResult> {
    const result = await postForCounts(this.call(), LOSS_COUNTS);
    if (result.told > 0) this.logger.log(`told staff about ${result.told} user(s) across ${result.tenants} tenant(s)`);
    return { itemsProcessed: result.told, errorsCount: result.failed, metrics: { ...result } };
  }
}
