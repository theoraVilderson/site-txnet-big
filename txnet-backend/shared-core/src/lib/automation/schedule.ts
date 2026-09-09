import { CronTime, validateCronExpression } from 'cron';

/**
 * When a worker is due — the whole of automation invariants #1 and #2, as a
 * pure function.
 *
 * **Why it is in a library rather than in `worker-service`.** Two processes now
 * decide about a schedule: the tick publisher, which asks whether one came due,
 * and the admin surface in `auth-service`, which refuses to *write* a shape
 * that could never run (F-031-b). An Nx app cannot import another Nx app, so
 * the only alternative to this file being here is the rule existing twice —
 * and a second copy of invariant #2 is exactly the drift the invariant is
 * about: a malformed row accepted by the writer and silently skipped by the
 * runner, with each side certain it is right.
 *
 * It is pure on purpose. The tick publisher runs on a timer inside a process
 * that also holds a broker connection and a database pool, and none of that is
 * needed to answer "should this key have run in the last minute". Keeping the
 * answer here is what lets `schedule.spec.ts` state the invariants without a
 * Postgres, and it is the reason `isActive` cannot be forgotten at one call
 * site and honoured at another: there is only one call site.
 */

export type ScheduleType = 'always_on' | 'time_window' | 'cron_expression';

/** The `bot_schedule` columns this decision reads, and no others. */
export interface ScheduleRow {
  scheduleType: ScheduleType;
  windowStartAt: Date | null;
  windowEndAt: Date | null;
  cronExpression: string | null;
  timezone: string;
  isActive: boolean;
}

/** The `bot_worker` columns this decision reads. */
export interface WorkerRow {
  key: string;
  isActive: boolean;
  schedules: ScheduleRow[];
}

/**
 * Invariant #2 as a check rather than as prose: `time_window` means the two
 * window columns and not `cronExpression`; `cron_expression` means the reverse;
 * `always_on` means neither. The schema cannot express it — every one of those
 * columns is nullable, because each is required by exactly one of the three
 * types — so a row that satisfies none of the three shapes is reachable by
 * hand, and this is where it stops.
 *
 * A malformed row is not "run anyway" and not "run always". It never runs, and
 * `explain` says why, because the alternative is a schedule that silently means
 * something other than what an admin typed.
 */
export function scheduleShapeError(schedule: ScheduleRow): string | null {
  const hasWindow =
    schedule.windowStartAt !== null || schedule.windowEndAt !== null;
  const hasCron =
    schedule.cronExpression !== null && schedule.cronExpression.trim() !== '';

  switch (schedule.scheduleType) {
    case 'always_on':
      return hasWindow || hasCron
        ? 'always_on carries neither a window nor a cron expression'
        : null;
    case 'time_window':
      if (hasCron) return 'time_window carries a cron expression';
      if (schedule.windowStartAt === null || schedule.windowEndAt === null)
        return 'time_window needs both windowStartAt and windowEndAt';
      if (schedule.windowEndAt <= schedule.windowStartAt)
        return 'time_window ends at or before it starts';
      return null;
    case 'cron_expression': {
      if (hasWindow) return 'cron_expression carries a window';
      if (!hasCron) return 'cron_expression needs a cronExpression';
      // A syntactically invalid expression is the same class of problem as a
      // missing one, and the same answer: it never runs. `cron` is asked
      // rather than a regex, because it is the parser that will read the
      // expression for real.
      const valid = validateCronExpression(schedule.cronExpression as string);
      if (!valid.valid)
        return `cronExpression is not a cron expression: ${valid.error?.message ?? 'invalid'}`;
      return null;
    }
  }
}

/**
 * Did `schedule` come due in the half-open interval `(since, now]`?
 *
 * The interval is what makes the decision independent of when the timer
 * actually fired. A tick that is late, or one the process missed entirely
 * because it was restarting, still finds the cron occurrence that fell in the
 * gap — which matters because at-least-once delivery (ADR-0027) buys nothing
 * if the publisher itself drops occurrences.
 */
function scheduleIsDue(
  schedule: ScheduleRow,
  since: Date,
  now: Date,
): boolean {
  if (!schedule.isActive) return false;
  if (scheduleShapeError(schedule) !== null) return false;

  switch (schedule.scheduleType) {
    case 'always_on':
      return true;
    case 'time_window':
      // `now` inside the window. The window is absolute, not recurring: the
      // schema stores two timestamps, so this is "run during this period",
      // which is how an admin switches a worker on for a campaign week.
      return (
        now >= (schedule.windowStartAt as Date) &&
        now <= (schedule.windowEndAt as Date)
      );
    case 'cron_expression': {
      // `getNextDateFrom` is strictly *after* the date it is given, so the
      // first occurrence it yields is the first one inside the open end of the
      // interval. Only its position relative to `now` is left to decide.
      // The timezone goes to `getNextDateFrom`, not to the constructor: the
      // constructor stores one for `CronJob`'s own timer and this call does not
      // read it, so a `timezone` column set only there is silently the
      // process's local zone — a nightly job that runs at the wrong midnight
      // on every host whose clock is not Tehran's.
      const next = new CronTime(schedule.cronExpression as string)
        .getNextDateFrom(since, schedule.timezone)
        .toJSDate();
      return next <= now;
    }
  }
}

export interface DueDecision {
  due: boolean;
  /** Why, in one line — the tick publisher logs this when it declines. */
  explain: string;
}

/**
 * Invariant #1 on its own, for a trigger that is not a schedule.
 *
 * An admin pressing "run now" bypasses the schedule — that is what the button
 * is for — but it must not bypass the kill switch, or `isActive = false` stops
 * being the thing an operator can trust to stop a worker. `workerIsDue` calls
 * this first, so the switch is still read in exactly one place however a run
 * was asked for.
 */
export function workerIsRunnable(worker: { isActive: boolean }): DueDecision {
  return worker.isActive
    ? { due: true, explain: 'worker isActive=true' }
    : { due: false, explain: 'worker isActive=false' };
}

/**
 * Invariant #1, stated where it cannot be skipped: `isActive = false` on the
 * worker stops every run of it regardless of what its schedules say. The
 * worker's own switch is checked before any schedule is looked at, so a worker
 * with an `always_on` schedule and `isActive = false` is off, which is the
 * whole point of calling it the fastest kill switch.
 */
export function workerIsDue(
  worker: WorkerRow,
  since: Date,
  now: Date,
): DueDecision {
  const blocked = workerIsRunnable(worker);
  if (!blocked.due) return blocked;
  if (worker.schedules.length === 0)
    return { due: false, explain: 'no schedule' };

  for (const schedule of worker.schedules) {
    const shape = scheduleShapeError(schedule);
    if (shape !== null) continue;
    if (scheduleIsDue(schedule, since, now))
      return { due: true, explain: `${schedule.scheduleType} is due` };
  }

  const malformed = worker.schedules
    .map(scheduleShapeError)
    .filter((e): e is string => e !== null);

  return {
    due: false,
    explain:
      malformed.length > 0
        ? `no schedule is due; ${malformed.length} malformed (${malformed[0]})`
        : 'no schedule is due',
  };
}
