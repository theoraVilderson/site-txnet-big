import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionStatus } from '@prisma/client';
import { BrokerService, TickMessage } from '../broker/broker.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerRegistryService } from './worker-registry.service';
import { TenantConcurrencyGate } from './tenant-concurrency.gate';
import { JobResult } from './job';

/**
 * The consumer half of ADR-0027, and the home of automation invariant #3:
 * **every run appends exactly one `bot_execution_log`, opened at the start and
 * closed on finish. Runs are never silent.**
 *
 * The row is written *before* the handler is called, not after. Writing it
 * afterwards would mean a job that crashes the process leaves no trace at all,
 * which is precisely the run an operator needs to see. The cost is a row with a
 * `startedAt` and no `finishedAt` for a run that was killed, and
 * `closeAbandonedRuns` below is what stops those accumulating.
 */
@Injectable()
export class TickConsumer implements OnModuleInit {
  private readonly logger = new Logger(TickConsumer.name);
  private readonly runTimeoutMs: number;

  constructor(
    private readonly broker: BrokerService,
    private readonly prisma: PrismaService,
    private readonly registry: WorkerRegistryService,
    private readonly gate: TenantConcurrencyGate,
    config: ConfigService,
  ) {
    this.runTimeoutMs = config.getOrThrow<number>('AUTOMATION_RUN_TIMEOUT_MS');
  }

  async onModuleInit() {
    // Before taking any new work, close out what a previous process left open.
    // It runs once per boot rather than on a timer: an abandoned row can only
    // be created by a process that died, and this is the moment one comes back.
    await this.closeAbandonedRuns();
    await this.broker.consumeTicks((tick) => this.run(tick));
  }

  private async run(tick: TickMessage): Promise<void> {
    const job = this.registry.job(tick.key);
    if (!job) {
      // A tick for a key this build does not implement. Not an error worth
      // failing on — another deployable may own it, or it may be in flight
      // across a rename — but it is worth one line, because a key that nothing
      // anywhere implements would otherwise be invisible.
      this.logger.warn(`no job registered for '${tick.key}' — ignoring the tick`);
      return;
    }

    // The per-tenant cap (F-066-p), asked *after* we know a job exists and
    // *before* any row is written. A deferral is not a run: it opens no
    // `bot_execution_log`, so invariant #3 keeps meaning what it says — every
    // row is a run that was actually attempted, and counting rows still counts
    // runs.
    const admission = this.gate.admit(tick);
    if (!admission.admitted) {
      if (admission.retry) this.defer(admission.retry, admission.afterMs);
      // A dropped tick returns normally rather than throwing: the gate has
      // already logged why, and throwing would nack it a second time and say
      // the job failed, which it never started.
      return;
    }

    const botWorkerId = await this.registry.idOf(tick.key);
    if (!botWorkerId) {
      // The row is written on boot, so this means it was deleted underneath a
      // live process. Refuse rather than invent one: a run with no `bot_worker`
      // has nowhere to append its log, and invariant #3 has no exception.
      this.logger.error(`bot_worker '${tick.key}' has no row — refusing the run`);
      throw new Error(`bot_worker '${tick.key}' is missing`);
    }

    const log = await this.prisma.botExecutionLog.create({
      data: {
        botWorkerId,
        triggeredBy: tick.triggeredBy,
        // The schema has no `running` state, so a row is born `failed` and is
        // corrected on success. That way the wrong answer for an interrupted
        // run is "it failed", which is true, rather than "it succeeded".
        status: ExecutionStatus.failed,
        metricsJson: { reason: tick.reason, tickAt: tick.at },
      },
      select: { id: true },
    });

    const startedAt = Date.now();
    try {
      const result: JobResult = await job.run();
      await this.close(log.id, this.statusOf(result), result, tick);
      this.logger.log(
        `${tick.key} finished in ${Date.now() - startedAt}ms (${result.itemsProcessed ?? 0} items, ${result.errorsCount ?? 0} errors)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.close(
        log.id,
        ExecutionStatus.failed,
        { errorsCount: 1, metrics: { error: message } },
        tick,
      );
      // Rethrown so `BrokerService` nacks it. The log row is already closed,
      // so the failure is recorded whether or not anyone reads the queue.
      throw err;
    } finally {
      // In a `finally`, so a job that throws does not leak a slot. A tenant
      // whose jobs all fail would otherwise reach its cap once and stay there
      // until the process restarts — a fairness control that turns into an
      // outage is worse than none.
      this.gate.release(tick);
    }
  }

  /**
   * Put a refused tick back on the exchange, after a delay.
   *
   * It is scheduled rather than awaited: awaiting it here would hold one of
   * `AUTOMATION_PREFETCH`'s slots for the length of the delay, which is the
   * head-of-line blocking the gate exists to avoid. The handler returns at
   * once, `BrokerService` acks the original, and the copy arrives behind
   * everything else in the queue — every other tenant's work goes first.
   *
   * The timer is `unref`ed so a pending deferral cannot keep a shutting-down
   * process alive. Losing it costs one occurrence, and the next scheduled tick
   * publishes another.
   */
  private defer(retry: TickMessage, afterMs: number): void {
    const timer = setTimeout(() => {
      this.broker.publishTick(retry).catch((err: unknown) =>
        this.logger.error(
          `could not re-publish deferred tick ${retry.key}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, afterMs);
    timer.unref?.();
  }

  /**
   * `partial` is what the schema's three-way status is for: a run that
   * processed some items and hit some errors is neither a success to be ignored
   * nor a failure to be retried whole.
   */
  private statusOf(result: JobResult): ExecutionStatus {
    if ((result.errorsCount ?? 0) === 0) return ExecutionStatus.success;
    return (result.itemsProcessed ?? 0) > 0
      ? ExecutionStatus.partial
      : ExecutionStatus.failed;
  }

  private async close(
    id: string,
    status: ExecutionStatus,
    result: JobResult,
    tick: TickMessage,
  ): Promise<void> {
    await this.prisma.botExecutionLog.update({
      where: { id },
      data: {
        finishedAt: new Date(),
        status,
        itemsProcessed: result.itemsProcessed ?? 0,
        errorsCount: result.errorsCount ?? 0,
        metricsJson: {
          reason: tick.reason,
          tickAt: tick.at,
          ...(result.metrics ?? {}),
        },
      },
    });
  }

  /**
   * A row still open past `AUTOMATION_RUN_TIMEOUT_MS` belonged to a process
   * that is gone. It is already `failed` — closing it only stamps a
   * `finishedAt`, so "how long did that run take" has an answer and an operator
   * counting open runs is not counting corpses.
   */
  private async closeAbandonedRuns(): Promise<void> {
    const cutoff = new Date(Date.now() - this.runTimeoutMs);
    const { count } = await this.prisma.botExecutionLog.updateMany({
      where: { finishedAt: null, startedAt: { lt: cutoff } },
      data: { finishedAt: new Date(), status: ExecutionStatus.failed },
    });
    if (count > 0)
      this.logger.warn(`closed ${count} run(s) abandoned by a previous process`);
  }
}
