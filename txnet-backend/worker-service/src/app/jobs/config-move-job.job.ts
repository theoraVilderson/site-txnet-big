import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { InternalCall, billingInternalCall, postForCounts } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const DRAIN_PATH = '/api/internal/billing/config-move-jobs/drain';
const DRAIN_COUNTS = ['jobs', 'moved', 'finished', 'purged'] as const;

/**
 * A reseller's move of many configs to one panel, moved in batches of 50
 * (F-311-ad, D-63). **The work is billing's and the clock is this service's**,
 * as `grant-bulk-job.job.ts` (ADR-0027): each move, its audit row and the
 * page's progress event live in `billing-service`.
 *
 * **Resumable and safe to run twice**: an item's outcome commits with its
 * move, so the next tick starts where this one stopped and moves nothing twice.
 * **It never succeeds quietly**: an unset seam, a refusal and an unreadable
 * answer each throw.
 */
@Injectable()
export class ConfigMoveJobDrainJob implements Job {
  readonly key = 'config_move_job_drain';
  readonly name = 'Config moves';
  readonly description = "Moves the next batch of every running config move job a reseller's admin started (F-311-ad).";
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, a started move stays `running` with nothing moved. An idle tick is one query. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'always_on' };
  /** A started move finishes whatever its tenant's status: starting it was the `staffWrite`, cancelling is the stop. */
  readonly tenantCapability = 'system' as const;

  private readonly logger = new Logger(ConfigMoveJobDrainJob.name);
  private readonly call: () => InternalCall;

  constructor(config: ConfigService) {
    this.call = billingInternalCall(config, DRAIN_PATH);
  }

  async run(): Promise<JobResult> {
    const result = await postForCounts(this.call(), DRAIN_COUNTS);
    if (result.moved > 0) this.logger.log(`moved ${result.moved} config(s) over ${result.jobs} move job(s), ${result.finished} finished`);
    return { itemsProcessed: result.moved, errorsCount: 0, metrics: { ...result } };
  }
}
