import { Prisma } from '@prisma/client';
import { METER_KEYS } from '@txnet-backend/shared-core';

import type { WholesaleRate } from '../decision/margin';
import { planMargins, rateInForce, type MarginPlan, type PackageRate } from './margins';

/**
 * F-1528 / ADR-0109 point 8: the reseller's margin per plan — its price
 * against what the platform charges for it now (the package's rate in force,
 * as a new sale or a renewal would lock it) — and a plan that loses money
 * flagged. Beside it, the active Grants on the plan and how many of them lose
 * money at the rate they locked: the accounts the engine's margin step stops.
 *
 * The failures worth a spec: a losing plan not flagged; a cost guessed where
 * it is unknown (no package, another currency, a metered plan) and so a plan
 * flagged or cleared on a made-up number; the wrong meter priced for an
 * unlimited plan; a future or retired rate read as the one in force; money as
 * a float (C-02).
 */

const NOW = new Date('2026-10-05T09:00:00Z');
const GIB = BigInt(1024 ** 3);
const D = (v: string) => new Prisma.Decimal(v);
const IRR = 'IRR';

const bag = (variantId: string, gib: number, price: string | null, over: Partial<MarginPlan> = {}): MarginPlan => ({
  variantId, productId: 'p1', sku: variantId, nameKey: `plan.${variantId}`, billingMode: 'prepaid', durationDays: 30, size: BigInt(gib) * GIB, unlimited: false,
  price: price === null ? null : { amount: D(price), currencyCode: IRR }, ...over,
});
const unlimited = (variantId: string, price: string): MarginPlan =>
  bag(variantId, 0, price, { size: null, unlimited: true });

const rate = (meterKey: string, unitPrice: string, over: Partial<PackageRate> = {}): PackageRate => ({
  meterKey,
  unitSize: meterKey === METER_KEYS.vpnTraffic ? GIB : BigInt(2_592_000),
  unitPrice: D(unitPrice),
  currencyCode: IRR,
  effectiveFrom: new Date('2026-09-01T00:00:00Z'),
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});
const leg = (unitPrice: string): WholesaleRate => ({ meterKey: METER_KEYS.vpnTraffic, unitSize: GIB, unitPrice: D(unitPrice), currencyCode: IRR });

describe('the rate in force (F-1528)', () => {
  it('is the newest row at or before now for the meter, never one that starts later', () => {
    const rows = [
      rate(METER_KEYS.vpnTraffic, '3000', { effectiveFrom: new Date('2026-08-01T00:00:00Z') }),
      rate(METER_KEYS.vpnTraffic, '4000', { effectiveFrom: new Date('2026-10-01T00:00:00Z') }),
      rate(METER_KEYS.vpnTraffic, '9000', { effectiveFrom: new Date('2026-11-01T00:00:00Z') }),
      rate(METER_KEYS.unlimitedTime, '1'),
    ];
    expect(rateInForce(rows, METER_KEYS.vpnTraffic, NOW)?.unitPrice.toString()).toBe('4000');
  });

  it('breaks a tie in one instant by the row written last', () => {
    const at = new Date('2026-10-01T00:00:00Z');
    const rows = [rate(METER_KEYS.vpnTraffic, '4000', { effectiveFrom: at, createdAt: at }), rate(METER_KEYS.vpnTraffic, '4100', { effectiveFrom: at, createdAt: new Date(at.getTime() + 1) })];
    expect(rateInForce(rows, METER_KEYS.vpnTraffic, NOW)?.unitPrice.toString()).toBe('4100');
  });
});

describe('margin per plan (F-1528)', () => {
  it('flags a plan whose price is under its cost at the rate in force, with the loss as Decimal and its currency', () => {
    // 50 GiB at 4 400 a GiB = 220 000 against a price of 200 000.
    const [p] = planMargins([bag('v50', 50, '200000')], [rate(METER_KEYS.vpnTraffic, '4400')], [], NOW);
    expect(p).toMatchObject({
      variantId: 'v50',
      price: { amount: '200000.00', currencyCode: IRR },
      cost: { amount: '220000.00', currencyCode: IRR },
      margin: { amount: '-20000.00', currencyCode: IRR },
      losingMoney: true,
    });
    expect(p.reasons).toEqual([expect.objectContaining({ code: 'wholesale_cost', meterKey: METER_KEYS.vpnTraffic })]);
  });

  it('lists the losing plans first, then the thinnest margin', () => {
    const out = planMargins(
      [bag('v20', 20, '100000'), bag('v50', 50, '200000'), bag('v100', 100, '500000')],
      [rate(METER_KEYS.vpnTraffic, '4400')],
      [],
      NOW,
    );
    expect(out.map((p) => [p.variantId, p.losingMoney, p.margin?.amount])).toEqual([
      ['v50', true, '-20000.00'],
      ['v20', false, '12000.00'],
      ['v100', false, '60000.00'],
    ]);
  });

  it('prices an unlimited plan by its days, on the time meter, not its bytes', () => {
    const [p] = planMargins([unlimited('vu', '300000')], [rate(METER_KEYS.vpnTraffic, '4400'), rate(METER_KEYS.unlimitedTime, '350000')], [], NOW);
    expect(p).toMatchObject({ cost: { amount: '350000.00' }, margin: { amount: '-50000.00' }, losingMoney: true });
  });

  it.each([
    ['no package rate', [] as PackageRate[], bag('v50', 50, '200000'), 'no_wholesale_leg'],
    ['a rate in another currency', [rate(METER_KEYS.vpnTraffic, '1', { currencyCode: 'USD' })], bag('v50', 50, '200000'), 'other_currency'],
    ['a metered plan', [rate(METER_KEYS.vpnTraffic, '4400')], bag('vm', 0, '1000', { billingMode: 'metered', size: null }), 'metered'],
  ])('says the cost is unknown with %s, and flags nothing', (_, rates, plan, why) => {
    const [p] = planMargins([plan], rates, [], NOW);
    expect(p).toMatchObject({ cost: null, margin: null, losingMoney: false });
    expect(p.reasons).toEqual([expect.objectContaining({ code: 'cost_unknown', why })]);
  });

  it('leaves out a plan with no price: it is not for sale', () => {
    expect(planMargins([bag('v50', 50, null)], [rate(METER_KEYS.vpnTraffic, '4400')], [], NOW)).toEqual([]);
  });

  it('counts the active Grants on a plan and those losing money at the rate they locked', () => {
    const [p] = planMargins(
      [bag('v50', 50, '200000')],
      [rate(METER_KEYS.vpnTraffic, '3000')],
      [
        { variantId: 'v50', leg: leg('3000'), count: 7 }, // 150 000: profitable
        { variantId: 'v50', leg: leg('4400'), count: 2 }, // 220 000: losing
        { variantId: 'v50', leg: null, count: 3 }, // no leg: unknown
        { variantId: 'other', leg: leg('9999'), count: 5 },
      ],
      NOW,
    );
    expect(p.losingMoney).toBe(false);
    expect(p.grants).toEqual({ active: 12, losing: 2, costUnknown: 3 });
  });
});
