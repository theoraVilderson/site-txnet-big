/**
 * Cohorts (F-1004-a, billing/contract.analytics-tabs.md "Cohorts").
 *
 * The ways this goes wrong quietly:
 *
 *  - **a share or a net per user divided by the wrong people.** Month k of a
 *    cohort is judged against the cohort's size — everyone who first bought
 *    in its month — never against who happened to buy in month k;
 *  - **an LTV that is not cumulative,** or a channel's curve that averages in
 *    cohorts too young to have reached month k, which drags it down the
 *    further right it goes;
 *  - **a tail drawn from one or two old cohorts.** Late months pool fewer
 *    cohorts, so a curve that is cumulative per point still falls to the
 *    right; a point from under 3 of the channel's cohorts (and not all of
 *    them) is left out;
 *  - **two currencies added.** Each is its own figure (principle 6);
 *  - **a small cohort shown to the platform's staff.** Under 5 people it is
 *    hidden, as every other cell is (ADR-0104 (3)).
 */
import { Prisma } from '@prisma/client';

import { CohortInput, cohortGridOf } from './analytics-cohort-grid';
import { currencyPlaces } from '../../../../test-support/currency-registry';

const [JUN, JUL, AUG, SEP, OCT, NOV] = ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01'];
const d = (v: string) => new Prisma.Decimal(v);

const input = (over: Partial<CohortInput> = {}): CohortInput => ({
  months: [SEP, OCT],
  sizes: [
    { cohort: SEP, source: 'web', users: 6 },
    { cohort: SEP, source: 'telegram', users: 4 },
    { cohort: OCT, source: 'web', users: 5 },
  ],
  active: [
    { cohort: SEP, month: SEP, source: 'web', users: 6 },
    { cohort: SEP, month: SEP, source: 'telegram', users: 4 },
    { cohort: SEP, month: OCT, source: 'web', users: 4 },
    { cohort: OCT, month: OCT, source: 'web', users: 5 },
  ],
  net: [
    { cohort: SEP, month: SEP, source: 'web', currencyCode: 'USD', net: d('60') },
    { cohort: SEP, month: SEP, source: 'telegram', currencyCode: 'USD', net: d('40') },
    { cohort: SEP, month: OCT, source: 'web', currencyCode: 'USD', net: d('40') },
    { cohort: OCT, month: OCT, source: 'web', currencyCode: 'USD', net: d('50') },
  ],
  ...over,
});
const how = { currencies: ['USD'], hides: false, places: currencyPlaces };

describe('cohortGridOf', () => {
  it("judges month k by the cohort's size, net per member, and LTV as the running sum", () => {
    const { cohorts, cells } = cohortGridOf(input(), how);
    expect(cohorts).toEqual([
      { cohort: SEP, users: 10 },
      { cohort: OCT, users: 5 },
    ]);
    // A cohort has a cell only for the months it has lived.
    expect(cells).toEqual([
      { cohort: SEP, k: 0, share: 1, netPerUser: { USD: '10.00' }, ltv: { USD: '10.00' } },
      { cohort: SEP, k: 1, share: 0.4, netPerUser: { USD: '4.00' }, ltv: { USD: '14.00' } },
      { cohort: OCT, k: 0, share: 1, netPerUser: { USD: '10.00' }, ltv: { USD: '10.00' } },
    ]);
  });

  it("pools a channel's curve over only the cohorts old enough to reach each month", () => {
    const { channels, channelLtv } = cohortGridOf(input(), how);
    expect(channels).toEqual([
      { source: 'web', users: 11 },
      { source: 'telegram', users: 4 },
    ]);
    expect(channelLtv).toEqual([
      // web at k 1 pools September alone, one of its two cohorts: left out.
      { source: 'web', k: 0, ltv: { USD: '10.00' } },
      { source: 'telegram', k: 0, ltv: { USD: '10.00' } },
      { source: 'telegram', k: 1, ltv: { USD: '10.00' } },
    ]);
  });

  it("leaves out a channel's point pooled from under 3 of its cohorts, never its first months", () => {
    // Five monthly cohorts of 5 web buyers, each paying 10 in its first month only.
    const months = [JUN, JUL, AUG, SEP, OCT];
    const { channelLtv } = cohortGridOf(
      {
        months,
        sizes: months.map((cohort) => ({ cohort, source: 'web', users: 5 })),
        active: months.map((cohort) => ({ cohort, month: cohort, source: 'web', users: 5 })),
        net: months.map((cohort) => ({ cohort, month: cohort, source: 'web', currencyCode: 'USD', net: d('50') })),
      },
      how,
    );
    // k 0..2 pool 5, 4 and 3 cohorts; k 3 and 4 only 2 and 1 — the tail that would mislead.
    expect(channelLtv.map((p) => p.k)).toEqual([0, 1, 2]);
  });

  it('keeps each currency its own figure', () => {
    const { cells } = cohortGridOf(input({ net: [...input().net, { cohort: SEP, month: SEP, source: 'web', currencyCode: 'EUR', net: d('5') }] }), { ...how, currencies: ['USD', 'EUR'] });
    expect(cells[0]).toMatchObject({ netPerUser: { USD: '10.00', EUR: '0.50' } });
    expect(cells[1]).toMatchObject({ ltv: { USD: '14.00', EUR: '0.50' } });
  });

  it("hides a cohort and a channel under 5 people from the platform's staff", () => {
    const small = input({
      months: [SEP, OCT, NOV],
      sizes: [...input().sizes, { cohort: NOV, source: 'bale', users: 3 }],
      active: [...input().active, { cohort: NOV, month: NOV, source: 'bale', users: 3 }],
    });
    const { cohorts, cells, channels, channelLtv } = cohortGridOf(small, { ...how, hides: true });
    expect(cohorts.find((c) => c.cohort === NOV)).toEqual({ cohort: NOV, people: 'fewer_than_5' });
    expect(cells.some((c) => c.cohort === NOV)).toBe(false);
    expect(channelLtv.some((c) => c.source === 'bale' || c.source === 'telegram')).toBe(false);
    expect(channels.find((c) => c.source === 'bale')).toEqual({ source: 'bale', people: 'fewer_than_5' });
    expect(channels.find((c) => c.source === 'telegram')).toEqual({ source: 'telegram', people: 'fewer_than_5' });
  });
});
