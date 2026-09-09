import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JOBS, Job } from './job';
import { WorkerRow } from '@txnet-backend/shared-core';

/**
 * The registry half of F-031: which jobs exist, and what the database says
 * about each of them.
 *
 * **A job registers itself.** On boot every `Job` provider is reconciled into a
 * `bot_worker` row keyed by its `key`. The alternative — an admin creating the
 * row before the code can run — makes a fresh database a deployment that
 * silently does nothing, and makes "which workers exist" a question the code
 * cannot answer about itself.
 *
 * **What boot does not touch is `isActive`.** The row's switch belongs to
 * whoever last flipped it (invariant #1), so a redeploy of a worker an admin
 * switched off must not switch it back on. Only the descriptive columns —
 * `name`, `description`, `category` — follow the code.
 *
 * **A row with no code is left alone.** A `bot_worker` this build does not
 * implement is not deleted: it may belong to another deployable, or to a job
 * removed in this release and restored in the next, and either way its
 * `bot_execution_log` history is referenced by foreign key. It simply never
 * becomes due here, because nothing publishes for a key no `Job` claims.
 */
@Injectable()
export class WorkerRegistryService implements OnModuleInit {
  private readonly logger = new Logger(WorkerRegistryService.name);
  private readonly byKey = new Map<string, Job>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(JOBS) private readonly jobs: Job[],
  ) {
    for (const job of jobs) {
      if (this.byKey.has(job.key))
        throw new Error(
          `two jobs claim the key '${job.key}' — bot_worker.key is unique (automation invariant #4)`,
        );
      this.byKey.set(job.key, job);
    }
  }

  async onModuleInit() {
    for (const job of this.jobs) {
      await this.prisma.botWorker.upsert({
        where: { key: job.key },
        create: {
          key: job.key,
          name: job.name,
          description: job.description ?? null,
          category: job.category,
        },
        update: {
          name: job.name,
          description: job.description ?? null,
          category: job.category,
        },
      });
    }
    this.logger.log(
      `registered ${this.jobs.length} job(s): ${[...this.byKey.keys()].join(', ') || '—'}`,
    );
  }

  job(key: string): Job | undefined {
    return this.byKey.get(key);
  }

  /**
   * The workers this build can actually run, with their schedules, in the shape
   * `workerIsDue` reads. Filtered to the registered keys rather than fetched
   * whole: publishing a tick for a key nothing consumes fills the queue with
   * messages that can only be nacked.
   */
  async schedulable(): Promise<WorkerRow[]> {
    const keys = [...this.byKey.keys()];
    if (keys.length === 0) return [];

    const rows = await this.prisma.botWorker.findMany({
      where: { key: { in: keys } },
      select: {
        key: true,
        isActive: true,
        schedules: {
          select: {
            scheduleType: true,
            windowStartAt: true,
            windowEndAt: true,
            cronExpression: true,
            timezone: true,
            isActive: true,
          },
        },
      },
    });

    return rows as WorkerRow[];
  }

  /** The `bot_worker.id` a run log needs, by key. */
  async idOf(key: string): Promise<string | null> {
    const row = await this.prisma.botWorker.findUnique({
      where: { key },
      select: { id: true },
    });
    return row?.id ?? null;
  }
}
