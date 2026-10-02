/**
 * The one place a wall-clock zone is decided (ADR-0108). Every instant is
 * stored in UTC; a zone is read only to answer a wall-clock question, and it
 * is resolved here: the user's own zone (chosen, or reported by the panel's
 * browser) -> the tenant's -> `PLATFORM_DEFAULT_TIMEZONE`.
 *
 * Pure: a service loads the two rows it already has and calls it. Never fed
 * from an IP (a VPN's exit server) or a messenger (Telegram and Bale send none).
 */

/** The platform's clock, and the zone of a tenant or user with none. Every `'Asia/Tehran'` in code reads this. */
export const PLATFORM_DEFAULT_TIMEZONE = 'Asia/Tehran';

/** Where a user's stored zone came from: their own choice, or the panel browser's `Intl` report. */
export const TIME_ZONE_SOURCES = ['user', 'browser'] as const;
export type TimeZoneSource = (typeof TIME_ZONE_SOURCES)[number];

export type UserZone = { timezone: string | null; timezoneSource: TimeZoneSource | null };
export type ResolvedTimeZone = { zone: string; from: TimeZoneSource | 'tenant' | 'platform' };

/** Longer than any IANA name; a bound before `Intl` sees the string. */
const MAX_ZONE_LENGTH = 64;

/**
 * The canonical IANA name of `zone` (`iran` -> `Asia/Tehran`), or null when
 * this runtime cannot read it or it is a fixed offset (`+03:30`) — no offset
 * is stored anywhere (ADR-0108 point 1), since DST is the IANA database's job.
 */
export function canonicalTimeZone(zone: unknown): string | null {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > MAX_ZONE_LENGTH) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return /^[+-]/.test(resolved) ? null : resolved;
}

/** Whether `zone` may be stored as a zone: an IANA name this runtime can read. */
export function isIanaZone(zone: unknown): zone is string {
  return canonicalTimeZone(zone) !== null;
}

/**
 * The zone a wall-clock question about this user is answered in. A stored
 * value the runtime cannot read is skipped, never thrown: a zone dropped from
 * the IANA database must not stop a send.
 */
export function resolveTimeZone(input: { user?: Partial<UserZone> | null; tenant?: { timezone?: string | null } | null }): ResolvedTimeZone {
  const own = canonicalTimeZone(input.user?.timezone);
  if (own) return { zone: own, from: input.user?.timezoneSource === 'browser' ? 'browser' : 'user' };
  const tenant = canonicalTimeZone(input.tenant?.timezone);
  if (tenant) return { zone: tenant, from: 'tenant' };
  return { zone: PLATFORM_DEFAULT_TIMEZONE, from: 'platform' };
}

/**
 * What a user's zone columns become after a report, or null when nothing is
 * written. A browser report never overwrites the user's choice (ADR-0108
 * point 4); the user may choose over anything, or clear (`zone: null`) so the
 * browser may report again. `zone` must already be validated: a non-IANA one
 * is a caller's bug and throws.
 */
export function nextUserZone(current: UserZone, report: { zone: string | null; source: TimeZoneSource }): UserZone | null {
  if (report.zone === null) {
    if (report.source !== 'user' || current.timezone === null) return null;
    return { timezone: null, timezoneSource: null };
  }
  const zone = canonicalTimeZone(report.zone);
  if (!zone) throw new RangeError(`not an IANA time zone: ${report.zone}`);
  if (report.source === 'browser' && current.timezoneSource === 'user' && current.timezone !== null) return null;
  if (current.timezone === zone && current.timezoneSource === report.source) return null;
  return { timezone: zone, timezoneSource: report.source };
}
