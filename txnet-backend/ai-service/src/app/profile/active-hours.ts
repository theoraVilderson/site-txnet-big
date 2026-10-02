const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** One bucket per hour of the week (ADR-0109 point 7), the shape `account_profile.activeHours` CHECKs. */
export const HOURS_OF_WEEK = 168;
/** "28-day decay" (point 7): an event four weeks old counts half as much as one now. */
export const ACTIVE_HOURS_HALF_LIFE_DAYS = 28;

/**
 * The UTC hour of week, Monday 00:00 = 0, Sunday 23:00 = 167. UTC on purpose:
 * the profile is a fact about instants, and the subject's zone (ADR-0108) is
 * applied once, when an action is scheduled (point 8), never stored here.
 */
export function hourOfWeek(at: Date): number {
  return ((at.getUTCDay() + 6) % 7) * 24 + at.getUTCHours();
}

/**
 * When an account is active, as a share per hour of week: each event weighs
 * `0.5 ^ (age / 28 days)`, and the buckets sum to 1. No event at all is 168
 * zeros — "unknown", which the scheduler reads as no preference, never as
 * "never active".
 */
export function activeHours(events: readonly Date[], now: Date): number[] {
  const buckets = new Array<number>(HOURS_OF_WEEK).fill(0);
  let total = 0;
  for (const at of events) {
    const ageDays = Math.max(0, now.getTime() - at.getTime()) / DAY_MS;
    const weight = Math.pow(0.5, ageDays / ACTIVE_HOURS_HALF_LIFE_DAYS);
    buckets[hourOfWeek(at)] += weight;
    total += weight;
  }
  return total === 0 ? buckets : buckets.map((w) => w / total);
}
