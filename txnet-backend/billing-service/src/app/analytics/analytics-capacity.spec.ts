/**
 * Capacity planning (F-1005-a, billing/contract.analytics-tabs.md "Capacity").
 *
 * The ways this goes wrong quietly:
 *
 *  - **a second forecast.** The rate is ai's (F-1525-a): the last 7 days, a
 *    younger history over itself, nothing under a day — a panel two days old
 *    must not be read as if it had a week;
 *  - **a full date past the month.** A month's traffic allowance starts empty
 *    on the 1st, so a run-out after the month's last day is no run-out;
 *  - **"full" hidden.** A panel past its allowance or its user cap is full
 *    today, not "no forecast";
 *  - **the wrong figure first.** Two capacities, one date: the sooner wins;
 *  - **a month's cost from one price.** A price change mid-month prices each
 *    day by its own row (`costOn`).
 */
import { Prisma } from '@prisma/client';

import { forecastPanel, monthCostUsd, projectMonth } from './analytics-capacity-forecast';

const TODAY = '2026-10-16';

/** Every day from `from` to `to`, both included, each with `bytes`. */
function days(from: string, to: string, bytes: number) {
  const out: { day: string; bytes: bigint }[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push({ day: new Date(t).toISOString().slice(0, 10), bytes: BigInt(bytes) });
  }
  return out;
}

const base = { today: TODAY, allowanceBytes: null, clients: [], maxClients: null };

describe('forecastPanel: traffic against the month', () => {
  it('projects the month from the last 7 days and dates the run-out inside it', () => {
    const f = forecastPanel({ ...base, traffic: days('2026-10-01', '2026-10-15', 10), firstTrafficDay: '2026-09-01', allowanceBytes: BigInt(200) });
    expect(f).toMatchObject({ usedBytes: '150', perDayBytes: '10', projectedBytes: '310', allowanceBytes: '200', observedDays: 7 });
    // 50 left at 10 a day: today and four more.
    expect(f.trafficFullOn).toBe('2026-10-20');
    expect(f.fullOn).toBe('2026-10-20');
    expect(f.daysUntilFull).toBe(4);
  });

  it('reads only the last 7 days for the rate, not the whole month', () => {
    const f = forecastPanel({ ...base, traffic: [...days('2026-10-01', '2026-10-08', 100), ...days('2026-10-09', '2026-10-15', 10)], firstTrafficDay: '2026-09-01' });
    expect(f.perDayBytes).toBe('10');
    expect(f.usedBytes).toBe('870');
  });

  it('reads a younger panel over its own days', () => {
    const f = forecastPanel({ ...base, traffic: days('2026-10-13', '2026-10-15', 30), firstTrafficDay: '2026-10-13' });
    expect(f).toMatchObject({ perDayBytes: '30', observedDays: 3 });
  });

  it('forecasts nothing under a day of history', () => {
    const f = forecastPanel({ ...base, traffic: [], firstTrafficDay: TODAY, allowanceBytes: BigInt(200) });
    expect(f).toMatchObject({ usedBytes: '0', perDayBytes: null, projectedBytes: null, trafficFullOn: null, fullOn: null, daysUntilFull: null });
  });

  it('has no run-out when the allowance outlasts the month', () => {
    const f = forecastPanel({ ...base, traffic: days('2026-10-01', '2026-10-15', 10), firstTrafficDay: '2026-09-01', allowanceBytes: BigInt(10_000) });
    expect(f.trafficFullOn).toBeNull();
  });

  it('says full today for a panel already past its allowance', () => {
    const f = forecastPanel({ ...base, traffic: days('2026-10-01', '2026-10-15', 10), firstTrafficDay: '2026-09-01', allowanceBytes: BigInt(100) });
    expect(f).toMatchObject({ trafficFullOn: TODAY, daysUntilFull: 0 });
  });
});

describe('forecastPanel: users against the cap', () => {
  const traffic = { traffic: [], firstTrafficDay: null };

  it('dates the cap from the growth since the oldest snapshot inside 7 days', () => {
    const f = forecastPanel({ ...base, ...traffic, clients: [{ day: '2026-10-01', clients: 0 }, { day: '2026-10-09', clients: 50 }, { day: TODAY, clients: 64 }], maxClients: 80 });
    expect(f).toMatchObject({ clients: 64, clientsPerDay: 2, clientsFullOn: '2026-10-24', fullOn: '2026-10-24', daysUntilFull: 8 });
  });

  it('has no date for a panel losing users, or with no cap', () => {
    const shrinking = forecastPanel({ ...base, ...traffic, clients: [{ day: '2026-10-09', clients: 70 }, { day: TODAY, clients: 64 }], maxClients: 80 });
    expect(shrinking.clientsFullOn).toBeNull();
    const uncapped = forecastPanel({ ...base, ...traffic, clients: [{ day: '2026-10-09', clients: 50 }, { day: TODAY, clients: 64 }] });
    expect(uncapped).toMatchObject({ clients: 64, maxClients: null, clientsFullOn: null });
  });

  it('says full today at the cap', () => {
    const f = forecastPanel({ ...base, ...traffic, clients: [{ day: TODAY, clients: 80 }], maxClients: 80 });
    expect(f).toMatchObject({ clientsFullOn: TODAY, daysUntilFull: 0 });
  });

  it('answers the sooner of the two', () => {
    const f = forecastPanel({
      ...base,
      traffic: days('2026-10-01', '2026-10-15', 10),
      firstTrafficDay: '2026-09-01',
      allowanceBytes: BigInt(200),
      clients: [{ day: '2026-10-09', clients: 50 }, { day: TODAY, clients: 64 }],
      maxClients: 66,
    });
    expect(f).toMatchObject({ trafficFullOn: '2026-10-20', clientsFullOn: '2026-10-17', fullOn: '2026-10-17', daysUntilFull: 1 });
  });
});

describe('projectMonth: money to the month end', () => {
  const d = (v: string) => new Prisma.Decimal(v);

  it('adds the 7-day rate for the days left, per currency, never across two', () => {
    const rows = [
      ...days('2026-10-01', '2026-10-15', 0).map((x) => ({ day: x.day, currencyCode: 'IRR', amount: d('100') })),
      { day: '2026-10-15', currencyCode: 'USD', amount: d('7') },
    ];
    const p = projectMonth(rows, '2026-09-01', TODAY);
    // 1500 so far, 100 a day for the 16 days left.
    expect(p?.get('IRR')?.toFixed(2)).toBe('3100.00');
    expect(p?.get('USD')?.toFixed(2)).toBe('23.00');
  });

  it('projects nothing under a day of history', () => {
    expect(projectMonth([], TODAY, TODAY)).toBeNull();
  });
});

describe('monthCostUsd: the month at each day\'s price', () => {
  const price = (effectiveFrom: string, usd: string) => ({ monthlyCostUsd: new Prisma.Decimal(usd), effectiveFrom: new Date(`${effectiveFrom}T00:00:00Z`), createdByUserId: null, createdAt: new Date('2026-01-01T00:00:00Z') });

  it('prices each day by the row in effect on it', () => {
    expect(monthCostUsd([price('2026-10-01', '31'), price('2026-10-16', '62')], TODAY)?.toFixed(2)).toBe('47.00');
  });

  it('is none with no price in the month', () => {
    expect(monthCostUsd([], TODAY)).toBeNull();
  });
});
