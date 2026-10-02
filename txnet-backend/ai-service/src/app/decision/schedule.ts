import { quietUntil, type QuietWindow } from '@txnet-backend/shared-core';

import { HOURS_OF_WEEK, hourOfWeek } from '../profile/active-hours';

/**
 * F-038-e / ADR-0109 point 8, the last step: when a suggestion goes out — the
 * subject's next active hour, outside their quiet window, before the action's
 * deadline (ADR-0108: active hours are UTC hours of week; the quiet window is
 * minutes on the user's own clock, the same rule notification holds the bot
 * by, `quietUntil` in shared-core).
 *
 * An hour is *active* when its share of the account's activity is above an
 * even spread (1/168). The slots are now, then each UTC hour start after it:
 *
 * 1. the first active slot outside the quiet window, before the deadline;
 * 2. else the first slot outside the quiet window before the deadline — a
 *    message at an ordinary hour beats none, when the deadline is near;
 * 3. else `null`: nothing can be sent in time, and the pipeline says so.
 *
 * With no activity known (168 zeros) step 1 finds nothing and step 2 is "now,
 * or the end of the quiet window".
 */

const HOUR_MS = 3_600_000;
/** How far ahead a slot is looked for: a week holds every hour of week once. */
const HORIZON_MS = 7 * 24 * HOUR_MS;

export function scheduleAt(input: {
  activeHours: readonly number[];
  quiet: QuietWindow | null;
  deadline: Date | null;
  now: Date;
  /** F-038-r: a season's window on the plan — slots from its start, before its end; `null` when none fits there, and the caller asks again without it. */
  notBefore?: Date;
  seasonEnd?: Date;
}): Date | null {
  const { activeHours, quiet } = input;
  const now = input.notBefore && input.notBefore.getTime() > input.now.getTime() ? input.notBefore : input.now;
  const t = now.getTime();
  const end = Math.min(input.deadline?.getTime() ?? Infinity, input.now.getTime() + HORIZON_MS, input.seasonEnd?.getTime() ?? Infinity);
  if (end <= t) return null;

  const slots: number[] = [t];
  for (let s = t - (t % HOUR_MS) + HOUR_MS; s < end; s += HOUR_MS) slots.push(s);

  const even = 1 / HOURS_OF_WEEK;
  const isActive = (s: number) => (activeHours[hourOfWeek(new Date(s))] ?? 0) > even;
  const isFree = (s: number) => quietUntil(quiet, new Date(s)) === null;

  const active = slots.find((s) => isActive(s) && isFree(s));
  if (active !== undefined) return new Date(active);

  // Inside the window now: the window's end is the first free moment, if it comes in time.
  const released = quietUntil(quiet, now);
  const free = released ? (released.getTime() < end ? released.getTime() : undefined) : t;
  return free === undefined ? null : new Date(free);
}
