/**
 * The overview's "what changed" lines (F-1001-j, billing/contract.analytics.md
 * "Insights"). No language model: each rule answers a key and its figures, or
 * nothing.
 *
 * The ways this goes wrong quietly:
 *
 *  - **a rule that always speaks.** Nothing compared, no change, a flat month
 *    (σ 0) — each says nothing, never "0% change" or a division by zero;
 *  - **the wrong product.** Net rose, so the product named is the one that
 *    pushed it up most — not a large one that fell;
 *  - **a person in the platform's view of a reseller.** A product hidden from
 *    the platform's staff in either window is never named (ADR-0104 (3)).
 */
import { Prisma } from '@prisma/client';

import { kpiInsight, productInsight, unusualDayInsight } from './analytics-insights';
import { countKpi, moneyKpi } from './analytics-figures';

const d = (v: string) => new Prisma.Decimal(v);
const usd = (v: string) => new Map([['USD', d(v)]]);

/** The overview's KPIs with every one flat, and the named ones changed. */
function kpis(changed: Partial<Record<string, [string | number, string | number]>> = {}, compared = true) {
  const money = (k: string) => {
    const [v, p] = changed[k] ?? ['10', '10'];
    return moneyKpi(usd(String(v)), compared ? usd(String(p)) : null, ['USD']);
  };
  const count = (k: string) => {
    const [v, p] = changed[k] ?? [5, 5];
    return countKpi(Number(v), compared ? Number(p) : null);
  };
  return {
    net: money('net'), gross: money('gross'), refunds: money('refunds'), topUps: money('topUps'), aov: money('aov'), arpu: money('arpu'),
    orders: count('orders'), buyers: count('buyers'), newBuyers: count('newBuyers'), returningBuyers: count('returningBuyers'),
    renewal: null, activeGrants: count('activeGrants'),
    bytesUsed: { value: '100', previous: compared ? '100' : null, delta: compared ? 0 : null },
  };
}

describe('the biggest KPI move', () => {
  it('names the KPI with the largest absolute delta, in the operating currency for money, a fall beating a smaller rise', () => {
    expect(kpiInsight(kpis({ orders: [6, 5], topUps: ['4', '10'] }), 'USD')).toEqual({ key: 'kpiMove', params: { kpi: 'topUps', delta: -0.6, currency: 'USD' } });
    expect(kpiInsight(kpis({ orders: [10, 4] }), 'USD')).toEqual({ key: 'kpiMove', params: { kpi: 'orders', delta: 1.5, currency: null } });
  });

  it('says nothing with nothing compared, nothing changed, or only a rise from zero (`new` is no ratio)', () => {
    expect(kpiInsight(kpis({ orders: [10, 4] }, false), 'USD')).toBeNull();
    expect(kpiInsight(kpis(), 'USD')).toBeNull();
    expect(kpiInsight(kpis({ orders: [3, 0] }), 'USD')).toBeNull();
  });
});

describe('the product behind the change in net', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  it('names the product that moved net most in the direction net moved, with its change', () => {
    // Net rose by 30: A +50, B -40 (larger than C's +20 but against the move), C +20.
    const now = new Map([[A, d('150')], [B, d('60')], [C, d('20')]]);
    const before = new Map([[A, d('100')], [B, d('100')]]);
    expect(productInsight(now, before, new Set(), 'USD')).toEqual({ key: 'productDrove', params: { productId: A, change: '50.00', currency: 'USD' } });
    // Net fell by 30: B is the one that pulled it down.
    expect(productInsight(new Map([[A, d('110')], [B, d('60')]]), before, new Set(), 'USD')).toEqual({ key: 'productDrove', params: { productId: B, change: '-40.00', currency: 'USD' } });
  });

  it('never names a hidden product, and says nothing when net did not move or nothing is compared', () => {
    const now = new Map([[A, d('150')], [C, d('110')]]);
    const before = new Map([[A, d('100')], [C, d('100')]]);
    expect(productInsight(now, before, new Set([A]), 'USD')).toEqual({ key: 'productDrove', params: { productId: C, change: '10.00', currency: 'USD' } });
    expect(productInsight(new Map([[A, d('100')]]), new Map([[A, d('100')]]), new Set(), 'USD')).toBeNull();
    expect(productInsight(now, null, new Set(), 'USD')).toBeNull();
  });
});

describe('an unusual day', () => {
  /** 28 days of history alternating 9 and 11 (mean 10, σ 1), then the window's days. */
  const history = Array.from({ length: 28 }, (_, i) => (i % 2 ? '11' : '9'));
  const days = (window: string[]) =>
    [...history, ...window].map((net, i) => ({ day: new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString().slice(0, 10), net: d(net) }));

  it('names the window day furthest past 2σ of its own previous 28 days, high or low', () => {
    expect(unusualDayInsight(days(['13']), 28, 'USD')).toEqual({ key: 'unusualDay', params: { day: '2026-09-29', net: '13.00', mean: '10.00', currency: 'USD' } });
    expect(unusualDayInsight(days(['5', '13']), 28, 'USD')).toMatchObject({ params: { day: '2026-09-29', net: '5.00' } });
  });

  it('says nothing for a day inside 2σ, a flat history (σ 0), or a day before the window', () => {
    expect(unusualDayInsight(days(['11.5']), 28, 'USD')).toBeNull();
    const flat = Array.from({ length: 29 }, (_, i) => ({ day: new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString().slice(0, 10), net: d(i === 28 ? '40' : '0') }));
    expect(unusualDayInsight(flat, 28, 'USD')).toBeNull();
    expect(unusualDayInsight(days([]), 28, 'USD')).toBeNull();
  });
});
