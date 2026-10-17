/**
 * Cost attribution (F-1002-b, billing/contract.analytics.md "Cost and margin").
 *
 * The ways this goes wrong quietly:
 *
 *  - **a day's cost that does not add up.** A panel's day is its month's
 *    price over the month's days, split by bytes; the shares, rounded, must
 *    still sum to the day exactly, or a month of margins drifts by cents;
 *  - **idle cost spread or lost.** A day with no traffic keeps its whole cost
 *    on the panel as `idle` — never spread over the next day's users, never 0;
 *  - **the wrong price on a day.** A price change mid-month prices each day by
 *    the row in effect on it (`costOn`, the one reading of it);
 *  - **a reseller's cost from the wrong ledger.** What a reseller pays the
 *    platform is its cost: wholesale charges net of refunds split by its bytes
 *    per product, a subscription charge spread over its period's days;
 *  - **a wholesale charge on the wrong product** (ADR-0151 (4)). A charge that
 *    names a Grant is that Grant's, whole; only one naming none is split by
 *    bytes — or an API Grant's charge lands on the reseller's VPN;
 *  - **a product with no panel costing nothing** (ADR-0151 (1)). A sale costs
 *    its variant's cost (a refund undoes it), a use its meter's unit cost.
 */
import { Prisma } from '@prisma/client';

import { attributePanelCosts, attributeWholesale, ownCosts, spreadSubscriptions } from './analytics-cost';

const PANEL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const PRODUCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '44444444-4444-4444-8444-444444444444';

const d = (v: string) => new Prisma.Decimal(v);
const price = (effectiveFrom: string, usd: string, createdAt = '2026-01-01T00:00:00Z') => ({
  panelId: PANEL,
  monthlyCostUsd: d(usd),
  effectiveFrom: new Date(`${effectiveFrom}T00:00:00Z`),
  createdByUserId: null,
  createdAt: new Date(createdAt),
});
const use = (day: string, bytes: number, r: { tenant?: string; product?: string | null; user?: string | null } = {}) => ({
  day,
  panelId: PANEL,
  servedTenantId: r.tenant ?? PLATFORM,
  productId: r.product === undefined ? PRODUCT_A : r.product,
  userId: r.user === undefined ? USER : r.user,
  bytes: BigInt(bytes),
});

describe('attributePanelCosts', () => {
  it('spreads the month over its days and splits a day by bytes, the shares summing to the day exactly', () => {
    // 30 USD over September's 30 days is 1 USD a day; thirds do not divide it.
    const rows = attributePanelCosts(['2026-09-10'], [price('2026-09-01', '30')], [
      use('2026-09-10', 1),
      use('2026-09-10', 1, { product: PRODUCT_B }),
      use('2026-09-10', 1, { tenant: RESELLER, user: null }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.kind === 'panel' && r.currencyCode === 'USD')).toBe(true);
    expect(rows.reduce((sum, r) => sum.plus(r.cost), d('0')).toFixed(6)).toBe('1.000000');
    expect(rows.find((r) => r.servedTenantId === RESELLER)).toMatchObject({ userId: null, bytes: BigInt(1) });
  });

  it('keeps a day with no traffic on the panel as idle, whole', () => {
    expect(attributePanelCosts(['2026-02-10'], [price('2026-01-01', '28')], [])).toEqual([
      { day: '2026-02-10', kind: 'idle', panelId: PANEL, servedTenantId: null, productId: null, userId: null, currencyCode: 'USD', cost: d('1'), bytes: BigInt(0) },
    ]);
  });

  it('prices each day by the row in effect on it, and nothing before the first', () => {
    const prices = [price('2026-09-15', '60'), price('2026-09-01', '30')];
    const cost = (day: string) => attributePanelCosts([day], prices, []).map((r) => r.cost.toFixed(2));
    expect(cost('2026-08-31')).toEqual([]);
    expect(cost('2026-09-14')).toEqual(['1.00']);
    expect(cost('2026-09-15')).toEqual(['2.00']);
  });
});

describe('attributeWholesale', () => {
  it('splits a day net of refunds by bytes per product, panel and user; a day with no bytes is unallocated', () => {
    const rows = attributeWholesale(
      [
        { day: '2026-09-10', currencyCode: 'USD', amount: d('9.00') },
        { day: '2026-09-10', currencyCode: 'USD', amount: d('-3.00') },
        { day: '2026-09-11', currencyCode: 'USD', amount: d('2.00') },
      ],
      [
        { day: '2026-09-10', productId: PRODUCT_A, panelId: PANEL, userId: USER, bytes: BigInt(2) },
        { day: '2026-09-10', productId: PRODUCT_B, panelId: PANEL, userId: null, bytes: BigInt(1) },
      ],
    );
    expect(rows.map((r) => [r.day, r.productId, r.panelId, r.userId, r.cost.toFixed(2)])).toEqual([
      ['2026-09-10', PRODUCT_A, PANEL, USER, '4.00'],
      ['2026-09-10', PRODUCT_B, PANEL, null, '2.00'],
      ['2026-09-11', null, null, null, '2.00'],
    ]);
    expect(rows.every((r) => r.kind === 'wholesale')).toBe(true);
  });
});

describe('spreadSubscriptions', () => {
  it('spreads each charge over the days until the next one, the last until the period end, inside the window only', () => {
    const rows = spreadSubscriptions(
      [
        { day: '2026-09-01', currencyCode: 'USD', amount: d('30.00') },
        { day: '2026-10-01', currencyCode: 'USD', amount: d('62.00') },
      ],
      { periodEnd: '2026-11-01', window: { from: '2026-09-30', to: '2026-10-02' } },
    );
    expect(rows.map((r) => [r.day, r.cost.toFixed(2)])).toEqual([
      ['2026-09-30', '1.00'],
      ['2026-10-01', '2.00'],
      ['2026-10-02', '2.00'],
    ]);
    expect(rows.every((r) => r.kind === 'subscription' && r.productId === null)).toBe(true);
  });
});

describe('attributeWholesale, a charge that names a Grant', () => {
  it("is that Grant's product, panel and user, whole; the rest of the day is split by bytes", () => {
    const grant = { productId: PRODUCT_B, panelId: null, userId: USER };
    const rows = attributeWholesale(
      [
        { day: '2026-10-01', currencyCode: 'USD', amount: d('4.00'), grant },
        { day: '2026-10-01', currencyCode: 'USD', amount: d('-1.00'), grant },
        { day: '2026-10-01', currencyCode: 'USD', amount: d('2.00') },
      ],
      [{ day: '2026-10-01', productId: PRODUCT_A, panelId: PANEL, userId: USER, bytes: BigInt(10) }],
    );
    expect(rows.map((r) => [r.productId, r.panelId, r.cost.toFixed(2)])).toEqual([
      [PRODUCT_B, null, '3.00'],
      [PRODUCT_A, PANEL, '2.00'],
    ]);
  });
});

describe('ownCosts', () => {
  it("costs a sale at its variant's cost, a refund back, and a use at its meter's unit cost — summed per cell", () => {
    const cell = { day: '2026-10-01', productId: PRODUCT_A, panelId: null, userId: USER, currencyCode: 'USD' };
    const rows = ownCosts(
      [
        { ...cell, cost: d('2.50'), sale: true, soldIn: 'USD' },
        { ...cell, cost: d('2.50'), sale: true, soldIn: 'USD' },
        { ...cell, cost: d('2.50'), sale: false, soldIn: 'USD' },
      ],
      [
        { ...cell, productId: PRODUCT_B, quantity: BigInt(12_500), unitSize: BigInt(1000), unitCost: d('0.04') },
        { ...cell, productId: PRODUCT_B, quantity: BigInt(500), unitSize: BigInt(1000), unitCost: d('0.04') },
      ],
    );
    expect(rows.map((r) => [r.kind, r.productId, r.cost.toFixed(6)])).toEqual([
      ['sale', PRODUCT_A, '2.500000'],
      ['usage', PRODUCT_B, '0.520000'],
    ]);
  });
});

describe('ownCosts, a cost of 0', () => {
  it('is kept as a row: 0 says "costs nothing", no row says "not set" (ADR-0151 (5))', () => {
    const rows = ownCosts([{ day: '2026-10-01', productId: PRODUCT_A, panelId: null, userId: USER, currencyCode: 'USD', cost: d('0'), sale: true, soldIn: 'USD' }], []);
    expect(rows.map((r) => [r.kind, r.cost.toFixed(2)])).toEqual([['sale', '0.00']]);
  });
});
