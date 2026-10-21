import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { InternalCall, billingInternalCall, postForCounts } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const DRAIN_PATH = '/api/internal/billing/migration-runs/drain';
const DRAIN_COUNTS = ['previewed', 'returned', 'committed', 'finished', 'rolledBack', 'rollbacksFinished', 'purged'] as const;

/**
 * One call reads one source panel: network-service gives a snapshot up to 2
 * minutes (network `contract.source.md`), and billing plans it after. Longer
 * than the seam's default on purpose, for this job alone.
 */
const DRAIN_TIMEOUT_MS = 5 * 60_000;

/**
 * A reseller's import from another panel (F-206, F-207, F-211, D-63): each
 * tick takes one run the reseller asked to preview, reads its source and
 * writes the dry run's report, one batch of a run the reseller committed, one
 * batch of a run it asked to roll back, and purges the snapshots of runs whose
 * window ended. **The work is billing's and the clock is this service's**, as
 * `config-move-job.job.ts` (ADR-0027).
 *
 * **Safe to run twice**: a run is leased while it is worked on, the report is
 * written only while the run is still this tick's, and each committed item's
 * outcome commits with its Grant. **It never succeeds
 * quietly**: an unset seam and an unreadable answer each throw; a source that
 * refused is the run's own reason, not this job's error.
 */
@Injectable()
export class MigrationRunDrainJob implements Job {
  readonly key = 'migration_run_drain';
  readonly name = 'Imports from another panel';
  readonly description = 'Previews each import a reseller asked for, commits or rolls back the next batch of each one it confirmed or undid, and purges what a closed window kept (F-206, F-207, F-211).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, a preview stays `previewing` with nothing read. An idle tick is one query. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'always_on' };
  /** A preview asked for finishes whatever its tenant's status: asking was the `staffWrite`, cancelling is the stop. */
  readonly tenantCapability = 'system' as const;

  private readonly logger = new Logger(MigrationRunDrainJob.name);
  private readonly call: () => InternalCall;

  constructor(config: ConfigService) {
    this.call = billingInternalCall(config, DRAIN_PATH);
  }

  async run(): Promise<JobResult> {
    const result = await postForCounts({ ...this.call(), timeoutMs: DRAIN_TIMEOUT_MS }, DRAIN_COUNTS);
    const done = result.previewed + result.returned + result.committed + result.rolledBack + result.purged;
    if (done > 0) {
      this.logger.log(
        `imports: ${result.previewed} previewed, ${result.returned} back to draft, ${result.committed} item(s) committed, ${result.finished} finished, ` +
          `${result.rolledBack} item(s) rolled back, ${result.rollbacksFinished} rollback(s) finished, ${result.purged} run(s) purged`,
      );
    }
    return { itemsProcessed: done, errorsCount: 0, metrics: { ...result } };
  }
}
