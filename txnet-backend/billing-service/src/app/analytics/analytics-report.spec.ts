/**
 * Scheduled reports (F-1006-a, billing/contract.analytics-reports.md).
 *
 * The ways this goes wrong quietly:
 *
 *  - **the wrong clock.** 09:00 is the tenant's 09:00 (TZ-1), never the
 *    server's or UTC's — a Tehran report at 09:00 leaves at 05:30 UTC;
 *  - **a run that never comes, or comes twice.** The next run is always after
 *    the last one, never equal to it, so a claim moves it forward;
 *  - **the wrong month.** A Persian reader's month is a Jalali one: a monthly
 *    report goes on 1 Aban, about 1 Farvardin..30 Mehr's month, not October's;
 *  - **a period that is not closed.** A report is about the days before its
 *    own day — a 09:00 report never counts a half of today;
 *  - **a sum across currencies.** The figures are the operating currency's.
 */
import { nextRunAt, periodOf } from './analytics-report-clock';
import { reportParams } from './analytics-report-figures';

const TEHRAN = 'Asia/Tehran';
const at = (iso: string) => new Date(iso);

describe('nextRunAt', () => {
  const daily = { frequency: 'daily' as const, weekday: null, hour: 9, calendar: 'gregorian' as const };

  it("is the tenant's hour, the next one strictly after the last", () => {
    // 2026-10-16 08:00 in Tehran is 04:30 UTC: today's 09:00 is still ahead.
    expect(nextRunAt(daily, TEHRAN, at('2026-10-16T04:30:00Z')).toISOString()).toBe('2026-10-16T05:30:00.000Z');
    // At 09:00 exactly, the next is tomorrow's: a claim always moves forward.
    expect(nextRunAt(daily, TEHRAN, at('2026-10-16T05:30:00Z')).toISOString()).toBe('2026-10-17T05:30:00.000Z');
  });

  it('runs a weekly report on its weekday', () => {
    // 2026-10-16 is a Friday (5); Monday (1) is the 19th.
    expect(nextRunAt({ ...daily, frequency: 'weekly', weekday: 1 }, TEHRAN, at('2026-10-16T05:30:00Z')).toISOString()).toBe('2026-10-19T05:30:00.000Z');
  });

  it("runs a monthly report on the first day of the reader's month", () => {
    expect(nextRunAt({ ...daily, frequency: 'monthly' }, TEHRAN, at('2026-10-16T05:30:00Z')).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    // 1 Aban 1405 is 23 October 2026.
    expect(nextRunAt({ ...daily, frequency: 'monthly', calendar: 'jalali' }, TEHRAN, at('2026-10-16T05:30:00Z')).toISOString()).toBe('2026-10-23T05:30:00.000Z');
  });
});

describe('periodOf', () => {
  const run = at('2026-10-23T05:30:00Z');

  it('covers the closed days before the run day', () => {
    expect(periodOf({ frequency: 'daily', calendar: 'gregorian' }, TEHRAN, run)).toEqual({ from: '2026-10-22', to: '2026-10-22' });
    expect(periodOf({ frequency: 'weekly', calendar: 'gregorian' }, TEHRAN, run)).toEqual({ from: '2026-10-16', to: '2026-10-22' });
  });

  it("covers the whole month just closed, in the reader's calendar", () => {
    // 1 Mehr 1405 is 23 September 2026.
    expect(periodOf({ frequency: 'monthly', calendar: 'jalali' }, TEHRAN, run)).toEqual({ from: '2026-09-23', to: '2026-10-22' });
    expect(periodOf({ frequency: 'monthly', calendar: 'gregorian' }, TEHRAN, at('2026-11-01T05:30:00Z'))).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });
});

describe('reportParams', () => {
  const money = (value: Record<string, string>, delta: Record<string, number | 'new' | null>) => ({ value, previous: null, delta });
  const kpis = {
    net: money({ IRT: '1500000', USD: '12.00' }, { IRT: 0.125, USD: 'new' }),
    topUps: money({ IRT: '900000' }, { IRT: -0.5 }),
    orders: { value: 30, previous: 20, delta: 0.5 },
    buyers: { value: 12, previous: 0, delta: 'new' as const },
  };

  it('says the operating currency only, each figure with its change', () => {
    expect(reportParams({ kpis }, 'IRT', { from: '2026-10-16', to: '2026-10-22' })).toEqual({
      from: '2026-10-16',
      to: '2026-10-22',
      currencyCode: 'IRT',
      net: '1500000',
      netDelta: '0.125',
      topUps: '900000',
      topUpsDelta: '-0.5',
      orders: '30',
      ordersDelta: '0.5',
      buyers: '12',
      buyersDelta: 'new',
    });
  });

  it('says zero for a currency with nothing in it, and no change where nothing was compared', () => {
    const quiet = { net: money({}, {}), topUps: money({}, {}), orders: { value: 0, previous: null, delta: null }, buyers: { value: 0, previous: null, delta: null } };
    expect(reportParams({ kpis: quiet }, 'IRT', { from: '2026-10-22', to: '2026-10-22' })).toMatchObject({ net: '0', netDelta: '', orders: '0', ordersDelta: '' });
  });
});
