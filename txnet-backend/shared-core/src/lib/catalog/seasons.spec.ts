import { describe, expect, it } from 'vitest';

import { jalaliToGregorian, seasonOccurrences, type SeasonRule } from './seasons';

/**
 * F-505-a: a tenant's seasons on the Jalali calendar, in the tenant's zone.
 *
 * The failures worth a spec: Nowruz a day off (the Jalali year starts on the
 * equinox, not on a fixed Gregorian date); 30 Esfand asked of a year that has
 * none; Thursday night counted in UTC instead of Tehran; an occurrence already
 * running missed, or one listed twice.
 */

const TEHRAN = 'Asia/Tehran';

describe('jalaliToGregorian', () => {
  it('Nowruz and Yalda land where the calendar puts them', () => {
    expect(jalaliToGregorian(1405, 1, 1)).toEqual({ year: 2026, month: 3, day: 21 });
    expect(jalaliToGregorian(1404, 1, 1)).toEqual({ year: 2025, month: 3, day: 21 });
    expect(jalaliToGregorian(1405, 9, 30)).toEqual({ year: 2026, month: 12, day: 21 });
    expect(jalaliToGregorian(1405, 7, 1)).toEqual({ year: 2026, month: 9, day: 23 });
  });

  it('a day the year does not have is none — 30 Esfand only in a leap year; a month past 12 never', () => {
    expect(jalaliToGregorian(1403, 12, 30)).toEqual({ year: 2025, month: 3, day: 20 });
    expect(jalaliToGregorian(1404, 12, 30)).toBeNull();
    expect(jalaliToGregorian(1405, 13, 1)).toBeNull();
    expect(jalaliToGregorian(1405, 7, 31)).toBeNull();
  });
});

describe('seasonOccurrences', () => {
  it('a dated season: Nowruz, four days from midnight Tehran, every year it reaches', () => {
    const nowruz: SeasonRule = { kind: 'dated', month: 1, day: 1, startMinute: 0, durationMinutes: 4 * 1440 };
    const got = seasonOccurrences(nowruz, TEHRAN, new Date('2026-03-01T00:00:00Z'), new Date('2027-04-01T00:00:00Z'));
    expect(got).toEqual([
      { startsAt: new Date('2026-03-20T20:30:00Z'), endsAt: new Date('2026-03-24T20:30:00Z') },
      { startsAt: new Date('2027-03-20T20:30:00Z'), endsAt: new Date('2027-03-24T20:30:00Z') },
    ]);
  });

  it('a weekly season: Thursday from 18:00 Tehran for twelve hours, in the zone not UTC', () => {
    const thursday: SeasonRule = { kind: 'weekly', weekday: 4, startMinute: 18 * 60, durationMinutes: 12 * 60 };
    // 2026-10-01 is a Thursday.
    const got = seasonOccurrences(thursday, TEHRAN, new Date('2026-09-30T00:00:00Z'), new Date('2026-10-10T00:00:00Z'));
    expect(got).toEqual([
      { startsAt: new Date('2026-10-01T14:30:00Z'), endsAt: new Date('2026-10-02T02:30:00Z') },
      { startsAt: new Date('2026-10-08T14:30:00Z'), endsAt: new Date('2026-10-09T02:30:00Z') },
    ]);
  });

  it('one already running is in, once; one ended before the window is not', () => {
    const thursday: SeasonRule = { kind: 'weekly', weekday: 4, startMinute: 18 * 60, durationMinutes: 12 * 60 };
    const got = seasonOccurrences(thursday, TEHRAN, new Date('2026-10-01T20:00:00Z'), new Date('2026-10-03T00:00:00Z'));
    expect(got).toEqual([{ startsAt: new Date('2026-10-01T14:30:00Z'), endsAt: new Date('2026-10-02T02:30:00Z') }]);
    expect(seasonOccurrences(thursday, TEHRAN, new Date('2026-10-02T03:00:00Z'), new Date('2026-10-03T00:00:00Z'))).toEqual([]);
  });
});
