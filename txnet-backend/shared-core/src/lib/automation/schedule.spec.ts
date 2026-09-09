import { ScheduleRow, WorkerRow, scheduleShapeError, workerIsDue } from './schedule';

/**
 * The item's one spec (`docs/CODE-LAYOUT.md`, the test budget). It states
 * automation invariants #1 and #2, which are the two that break silently:
 *
 * - #1 `bot_worker.isActive = false` stops all runs of that worker regardless
 *   of schedule. A kill switch that is checked in three places and forgotten in
 *   the fourth still looks like a kill switch, right up until the campaign
 *   sender an admin switched off sends anyway.
 * - #2 `bot_schedule`'s fields are mutually exclusive per `scheduleType`. Every
 *   one of those columns is nullable in the schema — each is required by
 *   exactly one of the three types — so a row satisfying none of the shapes is
 *   reachable, and the failure mode is a schedule that means something other
 *   than what was typed.
 *
 * What is deliberately not asserted here: that the publisher publishes and the
 * consumer consumes. Those are wiring written from the same understanding in
 * the same hour, and asserting them proves the understanding was consistent,
 * not that it was right.
 */

const at = (iso: string) => new Date(iso);

const schedule = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  scheduleType: 'always_on',
  windowStartAt: null,
  windowEndAt: null,
  cronExpression: null,
  timezone: 'Asia/Tehran',
  isActive: true,
  ...over,
});

const worker = (over: Partial<WorkerRow> = {}): WorkerRow => ({
  key: 'traffic_aggregator',
  isActive: true,
  schedules: [schedule()],
  ...over,
});

// A one-minute tick, which is what the publisher runs on.
const SINCE = at('2026-09-09T10:00:00.000Z');
const NOW = at('2026-09-09T10:01:00.000Z');

describe('workerIsDue — invariant #1, the kill switch', () => {
  it('runs an active worker on an always_on schedule', () => {
    expect(workerIsDue(worker(), SINCE, NOW).due).toBe(true);
  });

  it('does not run a worker with isActive=false, however loud its schedule', () => {
    const off = worker({ isActive: false, schedules: [schedule()] });
    expect(workerIsDue(off, SINCE, NOW)).toEqual({
      due: false,
      explain: 'worker isActive=false',
    });
  });

  it('does not run a worker whose only schedule is inactive', () => {
    const off = worker({ schedules: [schedule({ isActive: false })] });
    expect(workerIsDue(off, SINCE, NOW).due).toBe(false);
  });

  it('does not run a worker with no schedule at all', () => {
    expect(workerIsDue(worker({ schedules: [] }), SINCE, NOW).due).toBe(false);
  });
});

describe('scheduleShapeError — invariant #2, mutual exclusion', () => {
  it('accepts each of the three well-formed shapes', () => {
    expect(scheduleShapeError(schedule())).toBeNull();
    expect(
      scheduleShapeError(
        schedule({
          scheduleType: 'time_window',
          windowStartAt: at('2026-09-09T00:00:00.000Z'),
          windowEndAt: at('2026-09-16T00:00:00.000Z'),
        }),
      ),
    ).toBeNull();
    expect(
      scheduleShapeError(
        schedule({ scheduleType: 'cron_expression', cronExpression: '*/5 * * * *' }),
      ),
    ).toBeNull();
  });

  it('rejects a time_window that also carries a cron expression', () => {
    const row = schedule({
      scheduleType: 'time_window',
      windowStartAt: at('2026-09-09T00:00:00.000Z'),
      windowEndAt: at('2026-09-16T00:00:00.000Z'),
      cronExpression: '*/5 * * * *',
    });
    expect(scheduleShapeError(row)).toMatch(/cron/);
  });

  it('rejects a cron_expression that also carries a window', () => {
    const row = schedule({
      scheduleType: 'cron_expression',
      cronExpression: '*/5 * * * *',
      windowStartAt: at('2026-09-09T00:00:00.000Z'),
    });
    expect(scheduleShapeError(row)).toMatch(/window/);
  });

  it('rejects an always_on that carries either', () => {
    expect(
      scheduleShapeError(schedule({ cronExpression: '*/5 * * * *' })),
    ).not.toBeNull();
    expect(
      scheduleShapeError(
        schedule({ windowStartAt: at('2026-09-09T00:00:00.000Z') }),
      ),
    ).not.toBeNull();
  });

  it('rejects a time_window missing half of its window, and one that ends first', () => {
    expect(
      scheduleShapeError(
        schedule({
          scheduleType: 'time_window',
          windowStartAt: at('2026-09-09T00:00:00.000Z'),
        }),
      ),
    ).toMatch(/both/);
    expect(
      scheduleShapeError(
        schedule({
          scheduleType: 'time_window',
          windowStartAt: at('2026-09-16T00:00:00.000Z'),
          windowEndAt: at('2026-09-09T00:00:00.000Z'),
        }),
      ),
    ).toMatch(/before/);
  });

  it('rejects a cron_expression with nothing in the column', () => {
    expect(
      scheduleShapeError(
        schedule({ scheduleType: 'cron_expression', cronExpression: '   ' }),
      ),
    ).toMatch(/needs/);
  });
});

describe('workerIsDue — a malformed schedule never runs', () => {
  it('declines rather than falling back to always, and says how many', () => {
    const bad = worker({
      schedules: [schedule({ scheduleType: 'cron_expression', cronExpression: null })],
    });
    const decision = workerIsDue(bad, SINCE, NOW);
    expect(decision.due).toBe(false);
    expect(decision.explain).toMatch(/malformed/);
  });

  it('still runs a sibling schedule that is well formed', () => {
    const mixed = worker({
      schedules: [
        schedule({ scheduleType: 'cron_expression', cronExpression: null }),
        schedule(),
      ],
    });
    expect(workerIsDue(mixed, SINCE, NOW).due).toBe(true);
  });
});

describe('workerIsDue — time_window and cron', () => {
  it('runs inside its window and not outside it', () => {
    const inside = worker({
      schedules: [
        schedule({
          scheduleType: 'time_window',
          windowStartAt: at('2026-09-09T09:00:00.000Z'),
          windowEndAt: at('2026-09-09T11:00:00.000Z'),
        }),
      ],
    });
    expect(workerIsDue(inside, SINCE, NOW).due).toBe(true);

    const past = worker({
      schedules: [
        schedule({
          scheduleType: 'time_window',
          windowStartAt: at('2026-09-08T09:00:00.000Z'),
          windowEndAt: at('2026-09-08T11:00:00.000Z'),
        }),
      ],
    });
    expect(workerIsDue(past, SINCE, NOW).due).toBe(false);
  });

  it('fires a cron occurrence that fell inside the interval', () => {
    // 10:00:30Z is inside (10:00:00, 10:01:00].
    const every30s = worker({
      schedules: [
        schedule({
          scheduleType: 'cron_expression',
          cronExpression: '30 * * * * *',
          timezone: 'UTC',
        }),
      ],
    });
    expect(workerIsDue(every30s, SINCE, NOW).due).toBe(true);
  });

  it('does not fire when the next occurrence is past the interval', () => {
    // Midnight Tehran is nowhere near 10:00Z.
    const nightly = worker({
      schedules: [
        schedule({
          scheduleType: 'cron_expression',
          cronExpression: '0 0 * * *',
          timezone: 'Asia/Tehran',
        }),
      ],
    });
    expect(workerIsDue(nightly, SINCE, NOW).due).toBe(false);
  });

  it('catches an occurrence the process was down for — the interval is the gap, not the tick', () => {
    // Ten minutes of downtime across an hourly job that runs at :05.
    const hourly = worker({
      schedules: [
        schedule({
          scheduleType: 'cron_expression',
          cronExpression: '0 5 * * * *',
          timezone: 'UTC',
        }),
      ],
    });
    expect(
      workerIsDue(hourly, at('2026-09-09T10:00:00.000Z'), at('2026-09-09T10:10:00.000Z'))
        .due,
    ).toBe(true);
  });

  it('reads a cron expression in its own timezone', () => {
    // 13:30 Tehran is 10:00Z. The same expression in UTC is not due here.
    const tehran = (tz: string) =>
      worker({
        schedules: [
          schedule({
            scheduleType: 'cron_expression',
            cronExpression: '30 13 * * *',
            timezone: tz,
          }),
        ],
      });
    const since = at('2026-09-09T09:59:00.000Z');
    const now = at('2026-09-09T10:00:30.000Z');
    expect(workerIsDue(tehran('Asia/Tehran'), since, now).due).toBe(true);
    expect(workerIsDue(tehran('UTC'), since, now).due).toBe(false);
  });
});
