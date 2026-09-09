import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ScheduleType } from '@prisma/client';
import {
  ScheduleRow,
  scheduleShapeError,
  workerIsRunnable,
} from '@txnet-backend/shared-core';
import { PrismaService } from '../prisma/prisma.service';
import { ResponseType, err, ok } from '../common/response/response.util';
import { ManualTickPublisher } from './manual-tick.publisher';

/** The columns an admin sets on a schedule. `isActive` is not one of them. */
export type ScheduleInput = Omit<ScheduleRow, 'isActive'>;

export interface WorkerView {
  key: string;
  name: string;
  description: string | null;
  category: string;
  isActive: boolean;
  schedules: {
    id: string;
    scheduleType: ScheduleType;
    windowStartAt: Date | null;
    windowEndAt: Date | null;
    cronExpression: string | null;
    timezone: string;
    isActive: boolean;
    /** Non-null when this row could never run — invariant #2, said out loud. */
    shapeError: string | null;
  }[];
  lastRun: {
    startedAt: Date;
    finishedAt: Date | null;
    status: string;
    triggeredBy: string;
    itemsProcessed: number;
    errorsCount: number;
  } | null;
}

/**
 * The admin write surface over the worker registry (F-031-b).
 *
 * `worker-service` registers the workers and runs them; it serves no HTTP by
 * design (ADR-0027), so the surface that *writes* `bot_worker.isActive` and
 * `bot_schedule` lives here, in the process that already has an authenticated
 * admin, a permissions guard and an audit log. The two processes meet at the
 * three tables and at one exchange, and nowhere else.
 *
 * A worker is addressed by its `key`, never by its uuid. The key is the stable,
 * unique name invariant #4 is about, it is what the job class declares, and it
 * is the routing suffix of the tick — so it is the one identifier an operator
 * reading a log already has in front of them.
 */
@Injectable()
export class WorkerAdminService {
  private readonly logger = new Logger(WorkerAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ticks: ManualTickPublisher,
  ) {}

  /**
   * Every registered worker, its schedules and its last run.
   *
   * `shapeError` is computed per schedule rather than stored: a row that could
   * never run is invisible in the database and, before this surface existed,
   * invisible everywhere else too — the publisher declined it into a log
   * nobody reads. Answering it here is what makes invariant #2 reportable.
   */
  async list(): Promise<WorkerView[]> {
    const workers = await this.prisma.botWorker.findMany({
      orderBy: { key: 'asc' },
      include: {
        schedules: true,
        executionLogs: { orderBy: { startedAt: 'desc' }, take: 1 },
      },
    });

    return workers.map((worker) => ({
      key: worker.key,
      name: worker.name,
      description: worker.description,
      category: worker.category,
      isActive: worker.isActive,
      schedules: worker.schedules.map((schedule) => ({
        id: schedule.id,
        scheduleType: schedule.scheduleType,
        windowStartAt: schedule.windowStartAt,
        windowEndAt: schedule.windowEndAt,
        cronExpression: schedule.cronExpression,
        timezone: schedule.timezone,
        isActive: schedule.isActive,
        shapeError: scheduleShapeError(schedule),
      })),
      lastRun: worker.executionLogs[0]
        ? {
            startedAt: worker.executionLogs[0].startedAt,
            finishedAt: worker.executionLogs[0].finishedAt,
            status: worker.executionLogs[0].status,
            triggeredBy: worker.executionLogs[0].triggeredBy,
            itemsProcessed: worker.executionLogs[0].itemsProcessed,
            errorsCount: worker.executionLogs[0].errorsCount,
          }
        : null,
    }));
  }

  /**
   * Add a schedule to a worker — invariant #2, enforced where it is typed.
   *
   * The shape is checked with `scheduleShapeError`, the same function the tick
   * publisher declines on. That sameness is the point: a rule that lived twice
   * would drift into a row this surface accepts and the runner silently skips,
   * which is the exact failure the invariant describes.
   *
   * A refusal is a business rejection rather than a thrown error, and it
   * carries the rule that was broken. "Invalid schedule" with no reason leaves
   * an admin guessing which of three mutually exclusive shapes they missed.
   */
  async setSchedule(
    key: string,
    input: ScheduleInput,
    adminId: string,
  ): Promise<ResponseType<{ scheduleId: string }, { reason: string } | null>> {
    const worker = await this.mustFind(key);

    const shapeError = scheduleShapeError({ ...input, isActive: true });
    if (shapeError !== null) {
      this.logger.warn(`refused a schedule for ${key}: ${shapeError}`);
      return err('automation.invalidSchedule', { reason: shapeError });
    }

    const schedule = await this.prisma.botSchedule.create({
      data: {
        botWorkerId: worker.id,
        scheduleType: input.scheduleType,
        windowStartAt: input.windowStartAt,
        windowEndAt: input.windowEndAt,
        cronExpression: input.cronExpression,
        timezone: input.timezone,
        setByAdminId: adminId,
      },
      select: { id: true },
    });

    return ok({ scheduleId: schedule.id });
  }

  /**
   * Switch one schedule on or off.
   *
   * There is no delete. `bot_execution_log` says what ran and `setByAdminId`
   * says who asked for it; removing the row that explains a past run would
   * leave the history unreadable, and `isActive = false` already stops it —
   * `scheduleIsDue` reads it before anything else.
   */
  async toggleSchedule(
    key: string,
    scheduleId: string,
    isActive: boolean,
  ): Promise<{ scheduleId: string; isActive: boolean }> {
    const worker = await this.mustFind(key);
    const { count } = await this.prisma.botSchedule.updateMany({
      // Scoped by worker as well as by id, so a schedule id from one worker
      // cannot be flipped through another worker's URL.
      where: { id: scheduleId, botWorkerId: worker.id },
      data: { isActive },
    });
    if (count === 0) throw new NotFoundException();
    return { scheduleId, isActive };
  }

  /**
   * The kill switch (invariant #1), and the audit row that says who threw it.
   *
   * Both in one transaction: a worker that was switched off with no record of
   * who did it is the state an incident review cannot resolve, and the schema
   * has carried `bot_toggle` / `bot_worker` for exactly this since the catalog
   * was written.
   */
  async toggle(
    key: string,
    isActive: boolean,
    adminId: string,
    ip: string,
  ): Promise<{ key: string; isActive: boolean }> {
    const worker = await this.mustFind(key);

    await this.prisma.$transaction(async (tx) => {
      await tx.botWorker.update({ where: { id: worker.id }, data: { isActive } });
      await tx.adminAuditLog.create({
        data: {
          adminId,
          action: 'bot_toggle',
          targetEntityType: 'bot_worker',
          targetEntityId: worker.id,
          oldValue: { isActive: worker.isActive },
          newValue: { isActive },
          adminIpAddress: ip,
        },
      });
    });

    this.logger.log(`${key} switched ${isActive ? 'on' : 'off'} by ${adminId}`);
    return { key, isActive };
  }

  /**
   * Run a worker now, outside its schedule — `triggeredBy: 'admin_manual'`.
   *
   * It bypasses the schedule and **not** the switch. `workerIsRunnable` is the
   * same check `workerIsDue` opens with, so `isActive = false` still stops
   * every run of a worker however the run was asked for; a button that could
   * start a worker an operator had just switched off would make the fastest
   * kill switch the one nobody can trust.
   *
   * The run itself happens in `worker-service`, which is what makes this a
   * publish and not a call: the log row, the timeout and the at-least-once
   * redelivery all belong to the consumer (invariant #3).
   */
  async runNow(key: string): Promise<ResponseType<{ published: true }, null>> {
    const worker = await this.mustFind(key);

    const runnable = workerIsRunnable(worker);
    if (!runnable.due) {
      this.logger.warn(`refused a manual run of ${key}: ${runnable.explain}`);
      return err('automation.workerInactive');
    }

    await this.ticks.publishManualTick(key);
    return ok({ published: true as const });
  }

  /**
   * A key with no row is a 404 and not a created row. `worker-service` writes
   * these on boot from the job classes it holds; inventing one here would make
   * a typo look like a worker that exists and never runs.
   */
  private async mustFind(key: string) {
    const worker = await this.prisma.botWorker.findUnique({
      where: { key },
      select: { id: true, key: true, isActive: true },
    });
    if (!worker) throw new NotFoundException();
    return worker;
  }
}
