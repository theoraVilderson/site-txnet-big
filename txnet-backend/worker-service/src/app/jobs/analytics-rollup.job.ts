import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { InternalCall, billingInternalCall, postForCounts } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const REFRESH_PATH = '/api/internal/billing/analytics/refresh';
const REFRESH_COUNTS = ['tenants', 'changed', 'rebuilt'] as const;

/**
 * The clock on the analytics rollup (F-1001-a, billing/contract.analytics.md
 * "The worker"): today and yesterday of every tenant, and a whole rebuild of
 * one whose zone changed. Billing rolls up (`analytics/analytics-rollup.service.ts`);
 * the clock is this service's, over the internal seam, as `grant-unused-notice.job.ts` is.
 *
 * **Every 5 minutes**: the analytics page is "updated N min ago", and a pass
 * that changed nothing writes nothing — no event, no cache bump.
 *
 * **Safe to run twice** (ADR-0027): a pass replaces its window whole under a
 * per-tenant lock, so a redelivered tick rewrites the same rows.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw, so `TickConsumer` records a `failed` run (automation invariant #3).
 */
@Injectable()
export class AnalyticsRollupJob implements Job {
  readonly key = 'analytics_rollup';
  readonly name = 'Analytics rollup';
  readonly description =
    "Rolls each tenant's sales, buyers, payments and services up by day for the analytics page — today and yesterday, or the whole history after a time-zone change (F-1001-a).";
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, the analytics page shows figures that never move. Every five minutes. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '*/5 * * * *' };

  private readonly logger = new Logger(AnalyticsRollupJob.name);
  private readonly call: () => InternalCall;

  constructor(config: ConfigService) {
    this.call = billingInternalCall(config, REFRESH_PATH);
  }

  async run(): Promise<JobResult> {
    const result = await postForCounts(this.call(), REFRESH_COUNTS);
    if (result.changed > 0) this.logger.log(`rolled up ${result.changed} of ${result.tenants} tenant(s), ${result.rebuilt} rebuilt`);
    return { itemsProcessed: result.changed, errorsCount: 0, metrics: { ...result } };
  }
}
