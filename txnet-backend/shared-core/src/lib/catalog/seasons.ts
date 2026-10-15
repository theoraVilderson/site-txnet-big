import { jalaliOf, jalaliToGregorian } from '../time/jalali';
import { wallClock, zonedTime } from '../time/zoned';

/**
 * F-505-a: a tenant's seasons — named, recurring windows on the **Jalali**
 * calendar in the tenant's zone (ADR-0108): a dated one (Nowruz on 1
 * Farvardin, Yalda on 30 Azar) or a weekly one (Thursday night). Pure: the
 * catalog writes each coming occurrence as a campaign price (F-503-a), and the
 * AI engine reads the same occurrences (F-038-r, ADR-0109 point 15 — "seasons
 * come from F-505-a, not a second calendar").
 *
 * The calendar is `time/jalali.ts`, the runtime's own (`Intl`, `ca-persian`).
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
