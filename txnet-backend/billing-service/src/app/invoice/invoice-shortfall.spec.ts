import { FeeCalcMode, FeeType, Prisma, RateRoundingMode } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { GatewayPricing, priceAtGateway } from '../payment/pricing/gateway-pricing';
import { invoiceShortfall } from './invoice-shortfall';

const d = (v: string) => new Prisma.Decimal(v);

/** A USD card gateway with a minimum and a percentage fee: the two things that could eat a top-up. */
const pricing: GatewayPricing = {
  minAcceptAmount: d('5'),
  maxAcceptAmount: null,
  feeCalculationMode: FeeCalcMode.manual,
  feeType: FeeType.percentage,
  feeValue: d('3'),
  feeFloor: null,
  feeCeiling: null,
  useLiveRate: false,
  staticRate: d('1'),
  percentageModifier: null,
  fixedAmountModifier: null,
  minRate: null,
  maxRate: null,
  roundingStep: d('0.01'),
  roundingMode: RateRoundingMode.nearest,
  taxRatePercent: d('9'),
};

/**
 * What the panel pre-fills (F-111-e): `missing`, raised to the chosen gateway's
 * `minAmount` — below it the gateway refuses the top-up (400), and the server
 * cannot know which gateway the user will pick.
 */
const topUp = (missing: Prisma.Decimal) =>
  priceAtGateway({
    pricing,
    amount: Prisma.Decimal.max(missing, pricing.minAcceptAmount ?? missing),
    discount: d('0'),
    chargeDecimals: 2,
    chargesInBaseCurrency: true,
  });

describe('invoiceShortfall (F-111-c, spec §5.9)', () => {
  it('a cent-exact gap is the gap itself', () => {
    expect(invoiceShortfall(d('12.50'), d('5.00')).missing.toFixed()).toBe('7.5');
  });

  it('a sub-cent gap is rounded up, never down', () => {
    // Half-up would say 7.50 here and leave the user 0.004 short after topping it up.
    expect(invoiceShortfall(d('12.504'), d('5')).missing.toFixed()).toBe('7.51');
    expect(invoiceShortfall(d('12.50'), d('4.999999')).missing.toFixed()).toBe('7.51');
  });

  it('no balance at all is the whole total', () => {
    expect(invoiceShortfall(d('3.33'), d('0')).missing.toFixed()).toBe('3.33');
  });

  it.each([
    ['12.50', '5.00'],
    ['12.504', '5'],
    ['0.01', '0.004'],
    ['99.999999', '0.000001'],
    ['2', '0'], // under the gateway minimum: the minimum is topped up, and credited whole
  ])('a top-up of exactly `missing` always covers %s against a balance of %s', (total, balance) => {
    const s = invoiceShortfall(d(total), d(balance));
    // The deposit schema and the pricer take at most 2 places: a longer `missing` would be refused.
    expect(s.missing.decimalPlaces()).toBeLessThanOrEqual(2);
    // Fee and tax are on top of the amount, never taken from what is credited.
    const credited = topUp(s.missing).credited;
    expect(s.balance.plus(credited).gte(s.total)).toBe(true);
    // And it is the least such amount: one cent less would not cover.
    expect(s.balance.plus(s.missing).minus('0.01').lt(s.total)).toBe(true);
  });

  it('refuses a balance that already covers the total — it is not a shortfall', () => {
    expect(() => invoiceShortfall(d('5'), d('5'))).toThrow(RangeError);
  });
});
