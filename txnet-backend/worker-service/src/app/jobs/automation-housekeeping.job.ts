import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory, ExecutionStatus, Prisma } from '@prisma/client';

import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { PrismaService } from '../prisma/prisma.service';

/** Rows per DELETE (H14): short enough that no batch holds its locks for long. */
const BATCH_SIZE = 5_000;
const DAY_MS = 86_400_000;
/**
 * The run stops this long before `AUTOMATION_RUN_TIMEOUT_MS`, because at that
 * age `TickConsumer` closes a run as `failed` — a live run of this job would
 * be recorded dead while it was still deleting.
 */
const DEADLINE_MARGIN_MS = 60_000;

/** A run log's status, and the statuses kept the longer window (H14). */
const SUCCESS = [ExecutionStatus.success];
const FAILED = [ExecutionStatus.failed, ExecutionStatus.partial];

/** One batched DELETE; answers how many rows it removed. */
type Batch = () => Promise<number>;

/**
 * Keeps the two tables every tick and every event write to from growing for
 * ever (hosting H14, ADR-0126 point 6). Nothing else ever deleted from them:
 * by 2026-10-14 the dev `bot_execution_log` held ~400k rows after one month.
 *
 * - `bot_execution_log`: a success past `AUTOMATION_LOG_KEEP_DAYS` (30), a
 *   failed or partial run past `AUTOMATION_LOG_KEEP_FAILED_DAYS` (90) — the
 *   failures are what an operator comes back to read. Deleted per worker so
 *   each batch walks the `(botWorkerId, startedAt)` index.
 * - `outbox_event`: a **published** row past `OUTBOX_KEEP_DAYS` (7), through
 *   the `(publishedAt, occurredAt)` index. An unpublished row is an event no
 *   consumer has heard; it is never deleted, however old.
 *
 * **Batched, so the first run is the same loop.** Each statement deletes at
 * most 5,000 rows and the loop runs until one removes fewer, so a table months
 * behind needs no migration and no batch holds its locks for long. A run that
 * reaches its deadline stops, counts what is left, and the next night goes on.
 *
 * **Safe to run twice:** a second run finds nothing older than its windows.
 * Through `PrismaService` and not a seam: both tables are automation's own,
 * neither has RLS, and `txnet_app` holds DELETE on both.
 */
@Injectable()
export class AutomationHousekeepingJob implements Job {
  readonly key = 'automation_housekeeping';
  readonly name = 'Automation housekeeping';
  readonly description =
    'Deletes run logs past their window (30 days, failed 90) and published outbox events past 7 days, in batches of 5,000 (hosting H14).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, both tables grow for ever. 02:30 UTC: before the 03:15 rollup, off the hour. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '30 2 * * *' };

  private readonly logger = new Logger(AutomationHousekeepingJob.name);
  private readonly logKeepDays: number;
  private readonly failedKeepDays: number;
  private readonly outboxKeepDays: number;
  private readonly budgetMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.logKeepDays = config.get<number>('AUTOMATION_LOG_KEEP_DAYS', 30);
    this.failedKeepDays = config.get<number>('AUTOMATION_LOG_KEEP_FAILED_DAYS', 90);
    this.outboxKeepDays = config.get<number>('OUTBOX_KEEP_DAYS', 7);
    this.budgetMs = config.getOrThrow<number>('AUTOMATION_RUN_TIMEOUT_MS') - DEADLINE_MARGIN_MS;
  }

  async run(): Promise<JobResult> {
    const now = Date.now();
    const deadline = now + this.budgetMs;
    const before = (days: number) => new Date(now - days * DAY_MS);
    const successBefore = before(this.logKeepDays);
    const failedBefore = before(this.failedKeepDays);
    const outboxBefore = before(this.outboxKeepDays);

    const workers = await this.prisma.botWorker.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    const logBatches = workers.flatMap(({ id }) => [
      this.logBatch(id, SUCCESS, successBefore),
      this.logBatch(id, FAILED, failedBefore),
    ]);

    const executionLog = await this.drain(logBatches, deadline);
    const outbox = executionLog.finished
      ? await this.drain([this.outboxBatch(outboxBefore)], deadline)
      : { deleted: 0, finished: false };
    const finished = executionLog.finished && outbox.finished;

    const metrics: Record<string, unknown> = { executionLog: executionLog.deleted, outbox: outbox.deleted, finished };
    if (!finished) {
      metrics.left = {
        executionLog: await this.logLeft(successBefore, failedBefore),
        outbox: await this.outboxLeft(outboxBefore),
      };
      this.logger.warn(`stopped at its deadline; left for the next run: ${JSON.stringify(metrics.left)}`);
    }
    return { itemsProcessed: executionLog.deleted + outbox.deleted, errorsCount: 0, metrics };
  }

  /** Runs each batch until it removes fewer than `BATCH_SIZE`, stopping at `deadline`. */
  private async drain(batches: Batch[], deadline: number): Promise<{ deleted: number; finished: boolean }> {
    let deleted = 0;
    for (const batch of batches) {
      for (;;) {
        if (Date.now() >= deadline) return { deleted, finished: false };
        const removed = await batch();
        deleted += removed;
        if (removed < BATCH_SIZE) break;
      }
    }
    return { deleted, finished: true };
  }

  // `status::text`: Prisma binds a string as text, which Postgres will not
  // compare to the enum; the column is not indexed, so the cast costs nothing.
  private logBatch(botWorkerId: string, statuses: ExecutionStatus[], startedBefore: Date): Batch {
    return () => this.prisma.$executeRaw`
      DELETE FROM automation.bot_execution_log WHERE id IN (
        SELECT id FROM automation.bot_execution_log
         WHERE "botWorkerId" = ${botWorkerId}::uuid
           AND "startedAt" < ${startedBefore}
           AND status::text IN (${Prisma.join(statuses)})
         LIMIT ${BATCH_SIZE})`;
  }

  private outboxBatch(publishedBefore: Date): Batch {
    return () => this.prisma.$executeRaw`
      DELETE FROM automation.outbox_event WHERE id IN (
        SELECT id FROM automation.outbox_event
         WHERE "publishedAt" IS NOT NULL AND "publishedAt" < ${publishedBefore}
         LIMIT ${BATCH_SIZE})`;
  }

  private async logLeft(successBefore: Date, failedBefore: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ left: bigint }[]>`
      SELECT count(*) AS left FROM automation.bot_execution_log
       WHERE (status::text IN (${Prisma.join(SUCCESS)}) AND "startedAt" < ${successBefore})
          OR (status::text IN (${Prisma.join(FAILED)}) AND "startedAt" < ${failedBefore})`;
    return Number(rows[0]?.left ?? 0);
  }

  private async outboxLeft(publishedBefore: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ left: bigint }[]>`
      SELECT count(*) AS left FROM automation.outbox_event
       WHERE "publishedAt" IS NOT NULL AND "publishedAt" < ${publishedBefore}`;
    return Number(rows[0]?.left ?? 0);
  }
}
