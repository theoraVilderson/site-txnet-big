import { Prisma } from '@prisma/client';

import { seasonDateRefusal, seasonRuleOf, upcomingSeasonCampaigns, type SeasonWithPrices } from './season-plan';

/**
 * F-505-a (D-45): a season writes each coming occurrence as a campaign price
 * (F-503-a), once.
 *
 * The failures worth a spec: an occurrence already running written again (a
 * campaign cannot start in the past, and a half-written one would restore the
 * wrong price); one written twice by a second run; a season switched off still
 * writing; a Jalali date that never comes (31 Mehr) accepted as a season.
 */

const TEHRAN = 'Asia/Tehran';
const now = new Date('2026-09-30T00:00:00Z');
const thursday: SeasonWithPrices = {
  id: 's-1', tenantId: 't-1', kind: 'weekly', month: null, day: null, weekday: 4, startMinute: 18 * 60, durationMinutes: 12 * 60, isActive: true,
  prices: [{ variantId: 'v-1', amount: new Prisma.Decimal('90000.00') }, { variantId: 'v-2', amount: new Prisma.Decimal('150000.00') }],
};

describe('upcomingSeasonCampaigns', () => {
  it('every variant the season prices, for every occurrence starting ahead inside the horizon', () => {
    const got = upcomingSeasonCampaigns([thursday], () => TEHRAN, now, 14, new Set());
    expect(got.map((c) => [c.variantId, c.startsAt.toISOString()])).toEqual([
      ['v-1', '2026-10-01T14:30:00.000Z'], ['v-2', '2026-10-01T14:30:00.000Z'],
      ['v-1', '2026-10-08T14:30:00.000Z'], ['v-2', '2026-10-08T14:30:00.000Z'],
    ]);
    expect(got[0]).toMatchObject({ seasonId: 's-1', tenantId: 't-1', amount: new Prisma.Decimal('90000.00'), endsAt: new Date('2026-10-02T02:30:00Z') });
  });

  it('never one already running, never one written before, never a season switched off', () => {
    const running = new Date('2026-10-01T20:00:00Z');
    expect(upcomingSeasonCampaigns([thursday], () => TEHRAN, running, 3, new Set()).map((c) => c.startsAt.toISOString())).toEqual([]);
    const written = new Set(['s-1|v-1|2026-10-01T14:30:00.000Z']);
    expect(upcomingSeasonCampaigns([thursday], () => TEHRAN, now, 3, written).map((c) => c.variantId)).toEqual(['v-2']);
    expect(upcomingSeasonCampaigns([{ ...thursday, isActive: false }], () => TEHRAN, now, 14, new Set())).toEqual([]);
  });
});

describe('seasons as rules', () => {
  it('a dated season is its Jalali month and day; a day the month never has is refused', () => {
    expect(seasonRuleOf({ kind: 'dated', month: 1, day: 1, weekday: null, startMinute: 0, durationMinutes: 5760 })).toEqual({ kind: 'dated', month: 1, day: 1, startMinute: 0, durationMinutes: 5760 });
    expect(seasonDateRefusal({ kind: 'dated', month: 7, day: 31 })).toBe('season_date_invalid');
    expect(seasonDateRefusal({ kind: 'dated', month: 6, day: 31 })).toBeNull();
    expect(seasonDateRefusal({ kind: 'weekly', weekday: 4 })).toBeNull();
  });
});
