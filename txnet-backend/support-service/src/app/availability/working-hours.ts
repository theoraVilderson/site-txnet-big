import { wallClock, zonedTime } from '@txnet-backend/shared-core';

/**
 * A tenant's weekly support hours (F-033-g, user 2026-10-03): one schedule per
 * tenant, read on the tenant's own wall clock (`tenant.timezone`, ADR-0108).
 *
 * Pure — no database, no clock of its own — so the arithmetic SLA counts in
 * (F-033-h) is the same arithmetic the live/async choice is made with.
 *
 * **No interval at all means always open**: a tenant that never set hours is
 * answered by presence alone, and its SLA clock is the wall clock.
 */

/** `weekday` 0 = Sunday … 6 = Saturday; minutes past local midnight, `end` exclusive, `start < end <= 1440`. */
export interface HoursInterval {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface WorkingHours {
  zone: string;
  intervals: HoursInterval[];
}

const MINUTE_MS = 60_000;
/** Far enough that any schedule with one interval has an opening inside it. */
const SEARCH_DAYS = 8;

/** True when `hours` has no interval: open every minute. */
export function alwaysOpen(hours: WorkingHours): boolean {
  return hours.intervals.length === 0;
}

/**
 * The open windows, as instants, from the local day `from` falls on onwards —
 * sorted, merged where they touch (Saturday 22:00–24:00 + Sunday 00:00–02:00
 * is one window), and clipped to start no earlier than `from`.
 */
export function* openWindows(hours: WorkingHours, from: Date, days = SEARCH_DAYS): Generator<[Date, Date]> {
  const today = wallClock(from, hours.zone);
  let pending: [Date, Date] | null = null;
  for (let d = 0; d < days; d++) {
    const weekday = (today.weekday + d) % 7;
    const intervals = hours.intervals
      .filter((i) => i.weekday === weekday)
      .sort((a, b) => a.startMinute - b.startMinute);
    for (const i of intervals) {
      const start = zonedTime(today.year, today.month, today.day + d, i.startMinute, hours.zone);
      const end = zonedTime(today.year, today.month, today.day + d, i.endMinute, hours.zone);
      if (end <= from) continue;
      const clipped: [Date, Date] = [start < from ? from : start, end];
      if (pending && clipped[0] <= pending[1]) {
        if (clipped[1] > pending[1]) pending[1] = clipped[1];
        continue;
      }
      if (pending) yield pending;
      pending = clipped;
    }
  }
  if (pending) yield pending;
}

/** Inside a window at `at` (always, with no schedule). */
export function withinHours(hours: WorkingHours, at: Date): boolean {
  if (alwaysOpen(hours)) return true;
  for (const [start] of openWindows(hours, at, 2)) return start.getTime() === at.getTime();
  return false;
}

/** When support next opens — `null` while open now, or with no schedule. */
export function nextOpening(hours: WorkingHours, at: Date): Date | null {
  if (alwaysOpen(hours)) return null;
  for (const [start] of openWindows(hours, at)) return start.getTime() === at.getTime() ? null : start;
  return null;
}

/**
 * The instant `minutes` working minutes after `from` (F-033-h): a 4-hour
 * target set on Friday 22:00 against Sat–Wed 09–17 lands Saturday 13:00.
 */
export function addWorkingMinutes(hours: WorkingHours, from: Date, minutes: number): Date {
  if (alwaysOpen(hours)) return new Date(from.getTime() + minutes * MINUTE_MS);
  let left = minutes * MINUTE_MS;
  let cursor = from;
  // Walk week by week; a schedule with any interval yields at least one window per week.
  for (;;) {
    let last = cursor;
    for (const [start, end] of openWindows(hours, cursor)) {
      const span = end.getTime() - start.getTime();
      if (left <= span) return new Date(start.getTime() + left);
      left -= span;
      last = end;
    }
    if (last === cursor) throw new Error('working hours: no open window in a week');
    cursor = last;
  }
}

/** Working milliseconds between `from` and `to` (0 when `to` is not after `from`). */
export function workingMsBetween(hours: WorkingHours, from: Date, to: Date): number {
  if (to <= from) return 0;
  if (alwaysOpen(hours)) return to.getTime() - from.getTime();
  let total = 0;
  let cursor = from;
  while (cursor < to) {
    let last = cursor;
    for (const [start, end] of openWindows(hours, cursor)) {
      if (start >= to) return total;
      total += Math.min(end.getTime(), to.getTime()) - start.getTime();
      last = end;
      if (end >= to) return total;
    }
    if (last === cursor) return total;
    cursor = last;
  }
  return total;
}

