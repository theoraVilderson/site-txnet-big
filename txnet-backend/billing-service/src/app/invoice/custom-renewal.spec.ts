/**
 * A renewal of GiB and days typed, at the product's renewal rate (F-305-e,
 * billing contract.renewal.md rules 5, 6 and 8, ADR-0158 (4)).
 *
 * What would break silently here, and nowhere else:
 *  - the total is `gib × pricePerGib + days × pricePerDay`, rounded **once**,
 *    up, to the currency's places — never per part, never half-up (ADR-0153);
 *  - no rate in effect is `custom_renewal_off`, and so is a Grant that can take
 *    neither part;
 *  - a part the Grant cannot take (GiB on a metered or unlimited Grant, days on
 *    a permanent one) has a bound of 0 for that Grant, so typing it is out of
 *    bounds rather than charged for what renewGrant would drop;
 *  - a part typed as 0 is not bought; a part bought sits within its bounds.
 */
import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';

import { customBoundsFor, customRenewalOf, RenewalRateTerms } from './custom-renewal';
import { RenewableGrant, RenewalRefused } from './renewal-invoice';

const GIB = BigInt(1024 ** 3);
const D = (v: string) => new Prisma.Decimal(v);

const grant = (o: Partial<RenewableGrant> = {}): RenewableGrant => ({
  id: '99999999-9999-4999-8999-999999999999',
  status: GrantStatus.active,
  variantId: '55555555-5555-4555-8555-555555555551',
  productId: '44444444-4444-4444-8444-444444444444',
  panelGroupId: '88888888-8888-4888-8888-888888888888',
  billingMode: VariantBillingMode.prepaid,
  trafficUnlimited: false,
  endsAt: new Date('2026-11-01T00:00:00Z'),
  ...o,
});

const rate = (o: Partial<RenewalRateTerms> = {}): RenewalRateTerms => ({
  id: 'rate-1',
  pricePerGib: D('0.125'),
  pricePerDay: D('0.0333'),
  minGib: 5,
  maxGib: 500,
  minDays: 7,
  maxDays: 365,
  currencyCode: 'USD',
  ...o,
});

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof RenewalRefused) return e.reason;
    throw e;
  }
  return 'priced';
};

describe('customRenewalOf — the price (rule 8)', () => {
  it('prices both parts and rounds the total once, up, to the currency’s places', () => {
    // 10 × 0.125 + 30 × 0.0333 = 1.25 + 0.999 = 2.249 → 2.25, never 1.25 + 1.00
    const priced = customRenewalOf(grant(), rate(), { gib: 10, days: 30 }, 2);
    expect(priced).toEqual({ bytes: BigInt(10) * GIB, days: 30, amount: D('2.25') });
  });

  it('a part typed as 0 is not bought: days alone, bytes alone', () => {
    expect(customRenewalOf(grant(), rate(), { gib: 0, days: 30 }, 2)).toEqual({ bytes: BigInt(0), days: 30, amount: D('1') });
    expect(customRenewalOf(grant(), rate(), { gib: 20, days: 0 }, 0).amount).toEqual(D('3'));
  });
});

describe('customRenewalOf — refused (rules 5, 6)', () => {
  it('no rate in effect is custom renewal off', () => {
    expect(refusal(() => customRenewalOf(grant(), null, { gib: 10, days: 30 }, 2))).toBe('custom_renewal_off');
  });

  it.each([
    ['both 0', { gib: 0, days: 0 }],
    ['GiB under the fewest', { gib: 4, days: 0 }],
    ['GiB over the most', { gib: 501, days: 0 }],
    ['days under the fewest', { gib: 0, days: 6 }],
    ['days over the most', { gib: 0, days: 366 }],
  ])('%s is out of bounds', (_why, typed) => {
    expect(refusal(() => customRenewalOf(grant(), rate(), typed, 2))).toBe('custom_out_of_bounds');
  });

  it('a part the rate does not sell (a most of 0) is out of bounds', () => {
    expect(refusal(() => customRenewalOf(grant(), rate({ maxGib: 0, minGib: 0 }), { gib: 10, days: 0 }, 2))).toBe('custom_out_of_bounds');
  });

  it('a Grant that cannot be renewed is refused before the rate is read', () => {
    expect(refusal(() => customRenewalOf(grant({ status: GrantStatus.expired }), rate(), { gib: 10, days: 30 }, 2))).toBe('grant_not_renewable');
  });
});

describe('customBoundsFor — only the limited part (rule 6)', () => {
  it('a metered or unlimited Grant buys no GiB', () => {
    expect(customBoundsFor(grant({ billingMode: VariantBillingMode.metered }), rate())).toEqual({ minGib: 0, maxGib: 0, minDays: 7, maxDays: 365 });
    expect(customBoundsFor(grant({ trafficUnlimited: true }), rate()).maxGib).toBe(0);
    expect(refusal(() => customRenewalOf(grant({ trafficUnlimited: true }), rate(), { gib: 10, days: 30 }, 2))).toBe('custom_out_of_bounds');
  });

  it('a permanent Grant buys no days', () => {
    expect(customBoundsFor(grant({ endsAt: null }), rate())).toEqual({ minGib: 5, maxGib: 500, minDays: 0, maxDays: 0 });
  });

  it('a Grant that can take neither part has custom renewal off', () => {
    const metered = grant({ billingMode: VariantBillingMode.metered, endsAt: null });
    expect(refusal(() => customRenewalOf(metered, rate(), { gib: 0, days: 0 }, 2))).toBe('custom_renewal_off');
  });
});
