import { wallClock, zonedTime } from '../time/zoned';

/**
 * F-505-a: a tenant's seasons — named, recurring windows on the **Jalali**
 * calendar in the tenant's zone (ADR-0108): a dated one (Nowruz on 1
 * Farvardin, Yalda on 30 Azar) or a weekly one (Thursday night). Pure: the
 * catalog writes each coming occurrence as a campaign price (F-503-a), and the
 * AI engine reads the same occurrences (F-038-r, ADR-0109 point 15 — "seasons
 * come from F-505-a, not a second calendar").
 *
 * The calendar is the runtime's own (`Intl`, `ca-persian`): no table of
 * equinoxes to drift.
 */

export const SEASON_KINDS = ['dated', 'weekly'] as const;
export type SeasonKind = (typeof SEASON_KINDS)[number];

/**
 * When a season falls. `startMinute` is minutes past midnight on the zone's
 * clock; `durationMinutes` how long it lasts. `weekday`: JS numbering, Sunday
 * 0 … Saturday 6 (Thursday is 4).
 */
export type SeasonRule =
  | { kind: 'dated'; month: number; day: number; startMinute: number; durationMinutes: number }
  | { kind: 'weekly'; weekday: number; startMinute: number; durationMinutes: number };

export type Occurrence = { startsAt: Date; endsAt: Date };

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const persian = new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });

/** The Jalali (year, month, day) of a UTC calendar day. */
function jalaliOf(utcNoon: Date): { year: number; month: number; day: number } {
  const parts = persian.formatToParts(utcNoon);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { year: part('year'), month: part('month'), day: part('day') };
}

/**
 * The Gregorian day of a Jalali date, or `null` for one the year does not have
 * (30 Esfand outside a leap year, a 31st past the sixth month).
 */
export function jalaliToGregorian(jy: number, jm: number, jd: number): { year: number; month: number; day: number } | null {
  if (!Number.isInteger(jm) || !Number.isInteger(jd) || jm < 1 || jm > 12 || jd < 1 || jd > (jm <= 6 ? 31 : 30)) return null;
  // 1 Farvardin is the equinox's day: between 19 and 22 March of year + 621.
  const gy = jy + 621;
  let nowruz: number | null = null;
  for (let d = 19; d <= 22 && nowruz === null; d += 1) {
    const at = Date.UTC(gy, 2, d, 12);
    const j = jalaliOf(new Date(at));
    if (j.year === jy && j.month === 1 && j.day === 1) nowruz = at;
  }
  if (nowruz === null) return null;
  const dayOfYear = (jm <= 6 ? (jm - 1) * 31 : 186 + (jm - 7) * 30) + (jd - 1);
  const at = new Date(nowruz + dayOfYear * DAY_MS);
  const back = jalaliOf(at);
  if (back.year !== jy || back.month !== jm || back.day !== jd) return null;
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

/**
 * Every occurrence of `rule` in `zone` that overlaps [`from`, `until`) — one
 * already running included, once — in start order.
 */
export function seasonOccurrences(rule: SeasonRule, zone: string, from: Date, until: Date): Occurrence[] {
  const out: Occurrence[] = [];
  const duration = rule.durationMinutes * MINUTE_MS;
  // Start far enough back to catch one that began before `from` and is still running.
  const first = wallClock(new Date(from.getTime() - duration - DAY_MS), zone);
  const keep = (startsAt: Date) => {
    const endsAt = new Date(startsAt.getTime() + duration);
    if (endsAt.getTime() > from.getTime() && startsAt.getTime() < until.getTime()) out.push({ startsAt, endsAt });
  };
  if (rule.kind === 'weekly') {
    for (let i = 0; ; i += 1) {
      const startsAt = zonedTime(first.year, first.month, first.day + i, rule.startMinute, zone);
      if (startsAt.getTime() >= until.getTime()) break;
      // The weekday is the day's own on the zone's clock — the day the occurrence starts on.
      if (wallClock(zonedTime(first.year, first.month, first.day + i, 0, zone), zone).weekday === rule.weekday) keep(startsAt);
    }
    return out;
  }
  const firstJalali = jalaliOf(new Date(Date.UTC(first.year, first.month - 1, first.day, 12))).year;
  const lastJalali = jalaliOf(until).year;
  for (let jy = firstJalali; jy <= lastJalali + 1; jy += 1) {
    const g = jalaliToGregorian(jy, rule.month, rule.day);
    if (!g) continue;
    keep(zonedTime(g.year, g.month, g.day, rule.startMinute, zone));
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
