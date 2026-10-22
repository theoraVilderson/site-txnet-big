import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { InternalCall, postForCounts, tenantInternalCall } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const DRAIN_PATH = '/api/internal/tenant/data-exports/drain';
const DRAIN_COUNTS = ['built', 'failed', 'expired'] as const;

/**
 * One build reads a whole tenant inside one snapshot, up to tenant-service's
 * 10-minute build transaction, then stores it. Longer than both, for this job
 * alone, as `migration-run.job.ts` does for its source panels.
 */
const DRAIN_TIMEOUT_MS = 15 * 60_000;

/**
 * A reseller takes its data (F-212-a, catalog §14.8): each tick deletes the
 * archives past their days and builds one export a reseller asked for, into
 * one private archive on the storage port. **The work is tenant-service's and
 * the clock is this service's.**
 *
 * A platform tick (no `tenantId`), so no status refuses it — §14.8 asks for
 * an export in every state. **Safe to run twice**: an export is leased while
 * it is built and marked ready only while the lease is still this tick's. **It
 * never succeeds quietly**: an unset seam and an unreadable answer throw; a
 * build that failed is that export's own `failed`, not this job's error.
 */
@Injectable()
export class TenantDataExportDrainJob implements Job {
  readonly key = 'tenant_data_export_drain';
  readonly name = 'Reseller data exports';
  readonly description = 'Builds each data export a reseller asked for into one archive, and deletes archives past their days (F-212-a).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, an asked-for export stays `queued`. An idle tick is two queries. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'always_on' };

  private readonly logger = new Logger(TenantDataExportDrainJob.name);
  private readonly call: () => InternalCall;

  constructor(config: ConfigService) {
    this.call = tenantInternalCall(config, DRAIN_PATH);
  }

  async run(): Promise<JobResult> {
    const result = await postForCounts({ ...this.call(), timeoutMs: DRAIN_TIMEOUT_MS }, DRAIN_COUNTS);
    const done = result.built + result.failed + result.expired;
    if (done > 0) this.logger.log(`data exports: ${result.built} built, ${result.failed} failed, ${result.expired} expired`);
    return { itemsProcessed: done, errorsCount: result.failed, metrics: { ...result } };
  }
}
