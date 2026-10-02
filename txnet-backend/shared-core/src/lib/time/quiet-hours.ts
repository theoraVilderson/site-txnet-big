/**
 * A user's quiet window (F-601-m): minutes after local midnight in `timezone`.
 * Notification holds a bot message by it; the AI engine (F-038-e) schedules a
 * suggestion outside it. One rule, here, so the two never disagree.
 */

const DAY_MIN = 1440;

/** What `quietUntil` reads: a window and the zone it is in. */
export type QuietWindow = { quietStart: number | null; quietEnd: number | null; timezone: string | null };

/**
 * When a bot message due at `now` may be told, under a quiet window of
 * minutes after local midnight in `timezone` (F-601-m): `null` outside the
 * window, else the window's end — the next instant the local clock reads
 * `end`, on the minute. A window may wrap midnight (23:00-08:00).
 *
 * Minutes from the local clock, not a zone table: a DST jump inside the
 * window moves the release by that hour. Asia/Tehran has kept none since 2022.
 */
export function quietUntil(pref: QuietWindow | null, now: Date): Date | null {
  if (!pref || pref.quietStart === null || pref.quietEnd === null || pref.quietStart === pref.quietEnd || pref.timezone === null) return null;
  const minute = localMinute(now, pref.timezone);
  const { quietStart: start, quietEnd: end } = pref;
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!inside) return null;
  const wait = (end - minute + DAY_MIN) % DAY_MIN;
  const onTheMinute = now.getTime() - (now.getTime() % 60_000);
  return new Date(onTheMinute + wait * 60_000);
}

/**
 * `quietUntil` for a notice that may wait up to `waitSec` before it is told
 * (F-601-p): held also when the window opens inside that wait, until the end
 * of that window — a notice claimed at 22:30 and told at 23:30 is a night one.
 */
export function quietWithin(pref: QuietWindow | null, now: Date, waitSec: number): Date | null {
  const inside = quietUntil(pref, now);
  if (inside || !pref || pref.quietStart === null || pref.quietEnd === null || pref.quietStart === pref.quietEnd || pref.timezone === null) return inside;
  const toStart = (pref.quietStart - localMinute(now, pref.timezone) + DAY_MIN) % DAY_MIN;
  if (toStart * 60 > waitSec) return null;
  const onTheMinute = now.getTime() - (now.getTime() % 60_000);
  return quietUntil(pref, new Date(onTheMinute + toStart * 60_000));
}

function localMinute(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (part('hour') % 24) * 60 + part('minute');
}

