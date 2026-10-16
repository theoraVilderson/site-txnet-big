import { zonedTime } from '@txnet-backend/shared-core';

import { Calendar, bucketStart } from './analytics-buckets';
import { Day, addDays, dayOf } from './analytics-days';

/**
 * When a scheduled report goes and what it covers (F-1006-a,
 * contract.analytics-reports.md "The clock"), pure so the spec holds it.
 * Every hour and day is the **tenant's** (TZ-1); a month is the reader's
 * calendar's — a Jalali month for a Persian reader — as the page cuts it.
 */

export const REPORT_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];

/** A schedule's timing: `weekday` 0 (Sunday) – 6 for a weekly one, else null; `hour` 0–23 on the tenant's clock. */
export type ReportTiming = { frequency: ReportFrequency; weekday: number | null; hour: number; calendar: Calendar };

/** The furthest a next run can be: a monthly report waits at most a month and a day. */
const LOOKAHEAD_DAYS = 32;
const MINUTES_PER_HOUR = 60;

const weekdayOf = (day: Day) => new Date(`${day}T12:00:00Z`).getUTCDay();

/** Does a report of this timing go on `day`? */
function goesOn(t: ReportTiming, day: Day): boolean {
  if (t.frequency === 'weekly') return weekdayOf(day) === t.weekday;
  if (t.frequency === 'monthly') return bucketStart(day, 'month', t.calendar) === day;
  return true;
}

/** The first instant strictly after `after` at which the report is due — so a claim always moves it forward. */
export function nextRunAt(t: ReportTiming, zone: string, after: Date): Date {
  const first = dayOf(after, zone);
  for (let i = 0; i <= LOOKAHEAD_DAYS; i++) {
    const day = addDays(first, i);
    if (!goesOn(t, day)) continue;
    const [y, m, d] = day.split('-').map(Number);
    const at = zonedTime(y, m, d, t.hour * MINUTES_PER_HOUR, zone);
    if (at.getTime() > after.getTime()) return at;
  }
  throw new Error(`no ${t.frequency} report run within ${LOOKAHEAD_DAYS} days of ${after.toISOString()}`);
}

/**
 * The tenant days a report sent at `runAt` covers: the period that closed
 * before its day — yesterday, the 7 days before, or the month just ended.
 */
export function periodOf(t: Pick<ReportTiming, 'frequency' | 'calendar'>, zone: string, runAt: Date): { from: Day; to: Day } {
  const runDay = dayOf(runAt, zone);
  const to = addDays(runDay, -1);
  if (t.frequency === 'weekly') return { from: addDays(runDay, -7), to };
  if (t.frequency === 'monthly') return { from: bucketStart(to, 'month', t.calendar), to };
  return { from: to, to };
}
