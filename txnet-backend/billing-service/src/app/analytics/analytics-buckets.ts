import { jalaliOf } from '@txnet-backend/shared-core';

import { Day, addDays } from './analytics-days';

/**
 * How an analytics series is cut (billing/contract.analytics.md "Read routes"):
 * the server chooses, the answer names it, and the previous period is cut the
 * same way so the two align by index.
 */
export const GRANULARITIES = ['day', 'week', 'month'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** The calendar a week and a month are counted in — the reader's language picks it. */
export const CALENDARS = ['jalali', 'gregorian'] as const;
export type Calendar = (typeof CALENDARS)[number];

export const COMPARES = ['previous', 'year', 'none'] as const;
export type Compare = (typeof COMPARES)[number];

/** Up to this many days a series is daily, then weekly up to 26 weeks, then monthly. */
const DAILY_UP_TO_DAYS = 62;
const WEEKLY_UP_TO_DAYS = 26 * 7;

/** The longest window a read accepts: three years, a leap day included. */
export const MAX_RANGE_DAYS = 3 * 365 + 1;

/** The weekday a week starts on (JS numbering): Saturday in the Jalali calendar, Monday otherwise. */
const WEEK_STARTS: Record<Calendar, number> = { jalali: 6, gregorian: 1 };

const utc = (day: Day) => new Date(`${day}T12:00:00Z`);

/** Days in `from`..`to`, both included. */
export function daysIn(from: Day, to: Day): number {
  return Math.round((utc(to).getTime() - utc(from).getTime()) / 86_400_000) + 1;
}

export function granularityFor(from: Day, to: Day): Granularity {
  const days = daysIn(from, to);
  if (days <= DAILY_UP_TO_DAYS) return 'day';
  return days <= WEEKLY_UP_TO_DAYS ? 'week' : 'month';
}

/** The first day of the bucket `day` falls in. */
export function bucketStart(day: Day, granularity: Granularity, calendar: Calendar): Day {
  if (granularity === 'day') return day;
  if (granularity === 'week') return addDays(day, -((utc(day).getUTCDay() - WEEK_STARTS[calendar] + 7) % 7));
  if (calendar === 'gregorian') return `${day.slice(0, 8)}01`;
  return addDays(day, -(jalaliOf(utc(day)).day - 1));
}

/**
 * The buckets of `from`..`to` in order, each named by its first day inside
 * the window — so the first week or month is clipped to `from`, never earlier.
 * `keyOf` maps any day of the window to its bucket's name.
 */
export function bucketsOf(from: Day, to: Day, granularity: Granularity, calendar: Calendar): { keys: Day[]; keyOf: (day: Day) => Day } {
  const keyOf = (day: Day) => {
    const start = bucketStart(day, granularity, calendar);
    return start < from ? from : start;
  };
  const keys: Day[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const key = keyOf(day);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return { keys, keyOf };
}

/** `day` a calendar year earlier; 29 February becomes 1 March. */
function yearEarlier(day: Day): Day {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y - 1, m - 1, d)).toISOString().slice(0, 10);
}

/** The window a read is compared with: the same length just before, the same dates a year earlier, or none. */
export function previousRange(from: Day, to: Day, compare: Compare): { from: Day; to: Day } | null {
  if (compare === 'none') return null;
  if (compare === 'year') return { from: yearEarlier(from), to: yearEarlier(to) };
  const length = daysIn(from, to);
  return { from: addDays(from, -length), to: addDays(from, -1) };
}

/**
 * `from`..`to` cut into at most `points` runs of whole days, for a sparkline:
 * each point names its first day, and `keyOf` maps a day to its point.
 */
export function sparkPoints(from: Day, to: Day, points: number): { keys: Day[]; keyOf: (day: Day) => Day } {
  const days = daysIn(from, to);
  const width = Math.max(1, Math.ceil(days / points));
  const keys: Day[] = [];
  for (let i = 0; i < days; i += width) keys.push(addDays(from, i));
  const keyOf = (day: Day) => keys[Math.floor((daysIn(from, day) - 1) / width)];
  return { keys, keyOf };
}
