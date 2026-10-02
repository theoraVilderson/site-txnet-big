import { PLATFORM_DEFAULT_TIMEZONE, canonicalTimeZone, isIanaZone, nextUserZone, resolveTimeZone } from './time-zone';

/**
 * The item's one spec (TZ-1-a, ADR-0108 points 3 and 4). It states the two
 * rules that break silently when a fifth zone column appears:
 *
 * - the order: the user's own zone (chosen or reported) -> the tenant's ->
 *   the platform constant, with a value this runtime cannot read skipped, not
 *   thrown — a zone dropped from the IANA database must not stop a send;
 * - a browser report never overwrites a zone the user chose.
 *
 * And what may be stored at all: an IANA name, canonical, never an offset.
 */

describe('canonicalTimeZone / isIanaZone', () => {
  it.each([
    ['Asia/Tehran', 'Asia/Tehran'],
    ['asia/tehran', 'Asia/Tehran'],
    ['Iran', 'Asia/Tehran'],
    ['Europe/Berlin', 'Europe/Berlin'],
    ['UTC', 'UTC'],
    ['Etc/UTC', 'UTC'],
  ])('reads %s as %s', (zone, canonical) => {
    expect(canonicalTimeZone(zone)).toBe(canonical);
    expect(isIanaZone(zone)).toBe(true);
  });

  it.each(['+03:30', '-05:00', 'Foo/Bar', '', ' Asia/Tehran', 'x'.repeat(65), 42, null, undefined])('refuses %j', (zone) => {
    expect(canonicalTimeZone(zone)).toBeNull();
    expect(isIanaZone(zone)).toBe(false);
  });
});

describe('resolveTimeZone', () => {
  const tenant = { timezone: 'Europe/Istanbul' };

  it('takes the user own choice first', () => {
    expect(resolveTimeZone({ user: { timezone: 'Europe/Berlin', timezoneSource: 'user' }, tenant })).toEqual({ zone: 'Europe/Berlin', from: 'user' });
  });

  it('takes the zone the panel browser reported when the user chose none', () => {
    expect(resolveTimeZone({ user: { timezone: 'Asia/Dubai', timezoneSource: 'browser' }, tenant })).toEqual({ zone: 'Asia/Dubai', from: 'browser' });
  });

  it('falls to the tenant zone for a user with none', () => {
    expect(resolveTimeZone({ user: { timezone: null, timezoneSource: null }, tenant })).toEqual({ zone: 'Europe/Istanbul', from: 'tenant' });
    expect(resolveTimeZone({ user: null, tenant })).toEqual({ zone: 'Europe/Istanbul', from: 'tenant' });
  });

  it('falls to the platform constant with neither', () => {
    expect(resolveTimeZone({})).toEqual({ zone: PLATFORM_DEFAULT_TIMEZONE, from: 'platform' });
    expect(PLATFORM_DEFAULT_TIMEZONE).toBe('Asia/Tehran');
  });

  it('skips a stored value this runtime cannot read instead of throwing', () => {
    expect(resolveTimeZone({ user: { timezone: 'Mars/Olympus', timezoneSource: 'user' }, tenant: { timezone: '+03:30' } })).toEqual({
      zone: PLATFORM_DEFAULT_TIMEZONE,
      from: 'platform',
    });
  });

  it('answers the canonical name', () => {
    expect(resolveTimeZone({ tenant: { timezone: 'Iran' } }).zone).toBe('Asia/Tehran');
  });
});

describe('nextUserZone', () => {
  const none = { timezone: null, timezoneSource: null };
  const chosen = { timezone: 'Europe/Berlin', timezoneSource: 'user' as const };
  const reported = { timezone: 'Asia/Dubai', timezoneSource: 'browser' as const };

  it('never lets a browser report overwrite a zone the user chose', () => {
    expect(nextUserZone(chosen, { zone: 'Asia/Dubai', source: 'browser' })).toBeNull();
  });

  it('stores a browser report over nothing, or over an older report', () => {
    expect(nextUserZone(none, { zone: 'Asia/Dubai', source: 'browser' })).toEqual(reported);
    expect(nextUserZone(reported, { zone: 'Europe/Paris', source: 'browser' })).toEqual({ timezone: 'Europe/Paris', timezoneSource: 'browser' });
  });

  it('writes nothing when the report repeats what is stored', () => {
    expect(nextUserZone(reported, { zone: 'Asia/Dubai', source: 'browser' })).toBeNull();
  });

  it('lets the user choose over a report, and over their own earlier choice', () => {
    expect(nextUserZone(reported, { zone: 'Europe/Berlin', source: 'user' })).toEqual(chosen);
    expect(nextUserZone(chosen, { zone: 'America/Toronto', source: 'user' })).toEqual({ timezone: 'America/Toronto', timezoneSource: 'user' });
  });

  it('lets the user clear their choice, so the browser may report again', () => {
    expect(nextUserZone(chosen, { zone: null, source: 'user' })).toEqual(none);
  });

  it('stores the canonical name', () => {
    expect(nextUserZone(none, { zone: 'iran', source: 'user' })).toEqual({ timezone: 'Asia/Tehran', timezoneSource: 'user' });
  });

  it('throws on a zone that is not IANA — the caller validates first', () => {
    expect(() => nextUserZone(none, { zone: '+03:30', source: 'browser' })).toThrow(RangeError);
  });
});
