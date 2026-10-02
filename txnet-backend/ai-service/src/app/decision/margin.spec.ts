import { Prisma } from '@prisma/client';
import { METER_KEYS } from '@txnet-backend/shared-core';

import { candidatesFor, type PlanOption } from './candidates';
import { wholesaleCost, type WholesaleRate } from './margin';

/**
 * F-038-p / ADR-0109 point 8: the margin the pipeline ranks by is price minus
 * what the seller pays for the plan — a reseller's wholesale cost, at the rate
 * its Grant locked (entitlement `contract.package-wholesale.md`).
 *
 * The failures worth a spec: a cost counted in another currency than the
 * price (C-02); a cost guessed where none is recorded — the platform's own
 * sale or a reseller's own panels — instead of said to be unknown; a bag
 * priced by its partial unit as less than the reseller is charged; and a plan
 * that loses the reseller money pitched anyway.
 */

const GIB = BigInt(1024 ** 3);
const GRANT = '00000000-0000-4000-8000-0000000000b1';
const NOW = new Date('2026-10-05T09:20:00Z');
const DAY = 86_400_000;

const plan = (variantId: string, gib: number | null, price: number, durationDays: number | null = 30): PlanOption => ({
  variantId,
  productId: 'p1',
  billingMode: 'prepaid',
  durationDays,
  size: gib === null ? null : BigInt(gib) * GIB,
  price: { amount: new Prisma.Decimal(price), currencyCode: 'IRR' },
});

const perGib = (price: number, currencyCode = 'IRR'): WholesaleRate => ({
  meterKey: METER_KEYS.vpnTraffic,
  unitSize: GIB,
  unitPrice: new Prisma.Decimal(price),
  currencyCode,
});

describe('wholesaleCost (F-038-p)', () => {
  it('prices a bag at the locked rate per unit', () => {
    const c = wholesaleCost(plan('v50', 50, 200_000), perGib(2_400));
    expect(c.cost?.toFixed(2)).toBe('120000.00');
    expect(c.reason).toMatchObject({ code: 'wholesale_cost', meterKey: 'vpn.traffic', units: '50', cost: '120000.00' });
  });

  it('counts a partial unit whole, as the reseller is charged', () => {
    const rate = { ...perGib(1_000), unitSize: BigInt(10) * GIB };
    expect(wholesaleCost(plan('v25', 25, 100_000), rate).cost?.toFixed(2)).toBe('3000.00');
  });

  it('prices an unlimited plan by the days it sells', () => {
    const rate: WholesaleRate = { meterKey: METER_KEYS.unlimitedTime, unitSize: BigInt(30 * 86_400), unitPrice: new Prisma.Decimal(90_000), currencyCode: 'IRR' };
    expect(wholesaleCost(plan('vu', null, 300_000, 30), rate).cost?.toFixed(2)).toBe('90000.00');
  });

  it('says the cost is unknown with no wholesale leg — never guesses it', () => {
    expect(wholesaleCost(plan('v50', 50, 200_000), null)).toEqual({ cost: null, reason: { code: 'cost_unknown', why: 'no_wholesale_leg' } });
  });

  it('never subtracts a cost in another currency from the price (C-02)', () => {
    expect(wholesaleCost(plan('v50', 50, 200_000), perGib(1, 'USD'))).toEqual({ cost: null, reason: { code: 'cost_unknown', why: 'other_currency', currencyCode: 'USD' } });
  });
});

describe('candidates priced at the wholesale cost (F-038-p)', () => {
  const inputs = (rate: WholesaleRate | null, price = 200_000) => ({
    predictions: [
      { id: 'pr', kind: 'renewal_probability' as const, value: 0.8, predictedAt: null, confidence: 0.7, reasons: [{ code: 'rule_defaults', grantId: GRANT }] },
    ],
    grants: new Map([[GRANT, { id: GRANT, variantId: 'v50', endsAt: new Date(NOW.getTime() + 3 * DAY) }]]),
    plans: new Map([['v50', plan('v50', 50, price)]]),
    wholesale: new Map(rate ? [[GRANT, rate]] : []),
  });

  it('ranks by price minus the reseller cost', () => {
    const [c] = candidatesFor(inputs(perGib(2_400)), NOW);
    expect(c.expectedMargin).toEqual({ amount: '64000.00', currencyCode: 'IRR' });
    expect(c.reasons.map((r) => (r as { code: string }).code)).toEqual(expect.arrayContaining(['wholesale_cost', 'expected_margin']));
  });

  it('flags a plan that loses the reseller money', () => {
    const [c] = candidatesFor(inputs(perGib(5_000)), NOW);
    expect(c.expectedMargin?.amount).toBe('-40000.00');
    expect(c.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'expected_margin', losingMoney: true })]));
  });

  it('with no leg, the margin is the price and the reason says the cost is unknown', () => {
    const [c] = candidatesFor(inputs(null), NOW);
    expect(c.expectedMargin?.amount).toBe('160000.00');
    expect(c.reasons).toEqual(expect.arrayContaining([{ code: 'cost_unknown', why: 'no_wholesale_leg' }]));
  });
});
