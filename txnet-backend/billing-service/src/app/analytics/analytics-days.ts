import { wallClock, zonedMidnight } from '@txnet-backend/shared-core';

/** A tenant day, `YYYY-MM-DD` — what every rollup row's `day` is (billing/contract.analytics.md principle 5). */
export type Day = string;

const DAY_MS = 86_400_000;

const pad = (n: number) => String(n).padStart(2, '0');

/** The calendar date `at` falls on in `zone`. */
export function dayOf(at: Date, zone: string): Day {
  const w = wallClock(at, zone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** `day` moved by `days` on the calendar (no zone: a date has none). */
export function addDays(day: Day, days: number): Day {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The instants `[from, to)` that the zone's days `fromDay`..`toDay` cover, both included. */
export function dayBounds(fromDay: Day, toDay: Day, zone: string): { from: Date; to: Date } {
  const [fy, fm, fd] = fromDay.split('-').map(Number);
  const [ty, tm, td] = toDay.split('-').map(Number);
  return { from: zonedMidnight(fy, fm, fd, zone), to: zonedMidnight(ty, tm, td + 1, zone) };
}

/** Every day `fromDay`..`toDay`, both included, in order. */
export function daysBetween(fromDay: Day, toDay: Day): Day[] {
  const days: Day[] = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) days.push(day);
  return days;
}

/** `day` moved by `months` calendar months, the day of month clamped to the target month's last (31 January + 1 = 28 February): a month bought stays in its months (F-1001-t). */
export function addMonths(day: Day, months: number): Day {
  const [y, m, d] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
}
