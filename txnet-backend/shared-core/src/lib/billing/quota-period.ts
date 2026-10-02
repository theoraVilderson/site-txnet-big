import { isIanaZone, PLATFORM_DEFAULT_TIMEZONE } from '../time/time-zone';

/**
 * The fixed periods a sold quota is counted in (ADR-0107 point 7, F-019-v2):
 * never rolling, so a statement can say "1000 included, 43 extra this week".
 *
 *  - `day`   — from 00:00 to the next 00:00 on the platform's clock;
 *  - `week`  — from Saturday 00:00, seven days, on the same clock;
 *  - `month` — the reseller's subscription month: anchored on its
 *    `currentPeriodEnd` and stepped a calendar month at a time (UTC, clamped
 *    to the month's last day — the renewal's own step), so for a monthly plan
 *    it *is* the paid period and a yearly plan is split into its twelve
 *    months. A reseller with no subscription counts the calendar month on the
 *    platform's clock.
 *
 * The clock is `tenant_subscription_setting.quotaTimeZone` (an IANA zone,
 * default `PLATFORM_DEFAULT_TIMEZONE`). Every boundary is an instant; `start` is inside the
 * period, `end` is not.
 */
export type QuotaPeriodKind = 'day' | 'week' | 'month';

export type QuotaPeriod = { kind: QuotaPeriodKind; start: Date; end: Date };

export const DEFAULT_QUOTA_TIME_ZONE = PLATFORM_DEFAULT_TIMEZONE;

/** JS `getDay()` numbering: Saturday is 6. */
const WEEK_STARTS_ON = 6;

/** Whether `zone` is a time zone this runtime can read; the setting is checked with it before it is stored. One validator: ADR-0108's. */
export function isTimeZone(zone: string): boolean {
  return isIanaZone(zone);
}

type Wall = { year: number; month: number; day: number; weekday: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(at: Date, zone: string): Wall {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, f);
  }
  const parts = f.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(part('year')),
    month: Number(part('month')),
    day: Number(part('day')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday')),
    hour: Number(part('hour')),
    minute: Number(part('minute')),
    second: Number(part('second')),
  };
}

/** The zone's offset from UTC at `at`, in ms (Tehran: +3:30). */
function offsetAt(at: Date, zone: string): number {
  const w = wallClock(at, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant the zone's wall clock reads 00:00 on (year, month, day); month and day may overflow, as `Date.UTC` allows. */
function zonedMidnight(year: number, month: number, day: number, zone: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  // Twice: the second pass settles a midnight on the far side of an offset change.
  let at = guess - offsetAt(new Date(guess), zone);
  at = guess - offsetAt(new Date(at), zone);
  return new Date(at);
}

/** `anchor` stepped `n` calendar months (UTC), the day clamped to the month's last — the renewal's `addBillingPeriod` step. */
function monthsFrom(anchor: Date, n: number): Date {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + n;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(anchor.getUTCDate(), lastDay), anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
}

/**
 * The period of `kind` that holds `now`. `subscriptionEnd` is the reseller's
 * `currentPeriodEnd` (null: no subscription); only `month` reads it.
 */
export function quotaPeriodAt(kind: QuotaPeriodKind, now: Date, zone: string, subscriptionEnd: Date | null = null): QuotaPeriod {
  const w = wallClock(now, zone);
  if (kind === 'day') return { kind, start: zonedMidnight(w.year, w.month, w.day, zone), end: zonedMidnight(w.year, w.month, w.day + 1, zone) };
  if (kind === 'week') {
    const back = (w.weekday - WEEK_STARTS_ON + 7) % 7;
    return { kind, start: zonedMidnight(w.year, w.month, w.day - back, zone), end: zonedMidnight(w.year, w.month, w.day - back + 7, zone) };
  }
  if (!subscriptionEnd) return { kind, start: zonedMidnight(w.year, w.month, 1, zone), end: zonedMidnight(w.year, w.month + 1, 1, zone) };
  // The whole months between the anchor and now, then corrected by one either way for the day of the month.
  let n = (now.getUTCFullYear() - subscriptionEnd.getUTCFullYear()) * 12 + (now.getUTCMonth() - subscriptionEnd.getUTCMonth());
  while (monthsFrom(subscriptionEnd, n) > now) n--;
  while (monthsFrom(subscriptionEnd, n + 1) <= now) n++;
  return { kind, start: monthsFrom(subscriptionEnd, n), end: monthsFrom(subscriptionEnd, n + 1) };
}
