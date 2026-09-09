import { Injectable, Logger } from '@nestjs/common';
import { BotWorkerCategory } from '@prisma/client';
import { Job, JobResult } from '../automation/job';

/**
 * The one job this service ships with, and it is deliberately trivial.
 *
 * F-031-a builds the substrate: a deployable, a broker, a timer, a dispatcher
 * and a run log. Proving that end to end needs a job, and every *real* job
 * available today needs code that lives in another Nx application —
 * `destroyExpiredVersions` is `tenant`'s, inside `auth-service` — which is a
 * seam to decide rather than a thing to reach for mid-item (F-031-c).
 *
 * So this one does nothing but complete. What it is worth is exactly what it
 * claims: a `bot_worker` row an operator can switch off, a schedule they can
 * set, and a `bot_execution_log` trail that says the whole path is alive.
 * Delete it the day two real jobs exist.
 */
@Injectable()
export class HeartbeatJob implements Job {
  readonly key = 'worker_heartbeat';
  readonly name = 'Worker heartbeat';
  readonly description =
    'Does nothing and records that it did. Proves the tick path is alive.';
  readonly category = BotWorkerCategory.other;

  private readonly logger = new Logger(HeartbeatJob.name);

  async run(): Promise<JobResult> {
    this.logger.log('heartbeat');
    return { itemsProcessed: 1, errorsCount: 0, metrics: { alive: true } };
  }
}
