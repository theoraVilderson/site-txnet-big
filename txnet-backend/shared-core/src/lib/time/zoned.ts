/**
 * A zone's wall clock and the instant it names — the one implementation
 * (moved from `billing/quota-period.ts` for F-505-a's seasons, which count in
 * the tenant's zone as quota periods count in the platform's).
 */

export type Wall = { year: number; month: number; day: number; weekday: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

export function wallClock(at: Date, zone: string): Wall {
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
export function offsetAt(at: Date, zone: string): number {
  const w = wallClock(at, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant the zone's wall clock reads 00:00 on (year, month, day); month and day may overflow, as `Date.UTC` allows. */
export function zonedMidnight(year: number, month: number, day: number, zone: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  // Twice: the second pass settles a midnight on the far side of an offset change.
  let at = guess - offsetAt(new Date(guess), zone);
  at = guess - offsetAt(new Date(at), zone);
  return new Date(at);
}

/** The instant the zone's wall clock reads `minute` minutes past midnight on (year, month, day). */
export function zonedTime(year: number, month: number, day: number, minute: number, zone: string): Date {
  const guess = Date.UTC(year, month - 1, day) + minute * 60_000;
  let at = guess - offsetAt(new Date(guess), zone);
  at = guess - offsetAt(new Date(at), zone);
  return new Date(at);
}
