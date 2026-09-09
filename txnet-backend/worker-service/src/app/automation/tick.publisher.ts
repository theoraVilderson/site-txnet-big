import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { BrokerService } from '../broker/broker.service';
import { WorkerRegistryService } from './worker-registry.service';
import { workerIsDue } from '@txnet-backend/shared-core';

/**
 * The timer half of ADR-0027: **a schedule is a message.**
 *
 * This asks the database which registered workers came due since the last tick
 * and publishes one `automation.tick.<key>` for each. It runs no business work
 * itself, which is the whole point — the consumer does, and it can be a
 * different process, or four of them.
 *
 * `@nestjs/schedule` drives the timer, which ADR-0027 permits explicitly: what
 * it forbids is business work inside a request-serving process, and this
 * process serves no requests.
 *
 * **Two replicas publish two ticks.** That is the accepted cost of
 * at-least-once, stated rather than solved: a job must be safe to run twice
 * (`job.ts`), and a distributed lock here would be a queue with the durability
 * removed, which is the argument ADR-0027 settles.
 */
@Injectable()
export class TickPublisher implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TickPublisher.name);
  /**
   * The start of the interval the next tick asks about. Held in memory on
   * purpose: on a restart it becomes "now", so the gap the process was down
   * for is not replayed. Replaying it would mean a deploy fires every missed
   * occurrence at once — a nightly job that was down for a week sending seven
   * days of campaigns in one minute.
   */
  private since = new Date();

  private static readonly TIMER = 'automation-tick';

  constructor(
    private readonly registry: WorkerRegistryService,
    private readonly broker: BrokerService,
    private readonly scheduler: SchedulerRegistry,
    private readonly config: ConfigService,
  ) {}

  /**
   * Registered through `SchedulerRegistry` rather than with `@Interval`,
   * because a decorator argument is a compile-time constant and this interval
   * is deployment config — the same rule F-053 applied to the abuse limits.
   */
  onModuleInit() {
    this.since = new Date();
    const ms = this.config.getOrThrow<number>('AUTOMATION_TICK_INTERVAL_MS');
    const timer = setInterval(() => void this.tick(), ms);
    this.scheduler.addInterval(TickPublisher.TIMER, timer);
    this.logger.log(`ticking every ${ms}ms`);
  }

  onApplicationShutdown() {
    if (this.scheduler.doesExist('interval', TickPublisher.TIMER))
      this.scheduler.deleteInterval(TickPublisher.TIMER);
  }

  async tick(): Promise<void> {
    const now = new Date();
    const since = this.since;
    // Advanced before the work, not after: a slow or failed pass must not make
    // the next interval ask about a window that overlaps this one, which would
    // publish the same occurrence twice for no reason.
    this.since = now;

    let workers;
    try {
      workers = await this.registry.schedulable();
    } catch (err) {
      this.logger.error(
        `could not read schedules: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    for (const worker of workers) {
      const decision = workerIsDue(worker, since, now);
      if (!decision.due) continue;
      try {
        await this.broker.publishTick({
          key: worker.key,
          at: now.toISOString(),
          reason: decision.explain,
          triggeredBy: 'cron',
        });
        this.logger.log(`published automation.tick.${worker.key} (${decision.explain})`);
      } catch (err) {
        this.logger.error(
          `could not publish tick for ${worker.key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
