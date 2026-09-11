import { CouponVisibility, DiscountType, Prisma } from '@prisma/client';

import {
  applyCoupons,
  CouponFacts,
  CouponRequest,
  InvalidCouponInput,
  normalizeCouponCodes,
} from './coupon-validation';

/**
 * Coupon validation (F-092-g; D-21, D-23).
 *
 * The invariant this file holds is the discount a user is shown and later
 * reserved (F-092-h): codes stack in the order typed, each takes its discount
 * from what the previous ones left, and no code — alone or stacked — takes the
 * payable below zero. A rejected code takes nothing and leaves the running
 * payable alone. The loader's half — which rows a tenant can see and how many
 * live redemptions a user holds — needs Postgres: `coupon-validation.int.spec.ts`.
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const NOW = new Date('2026-09-11T12:00:00Z');
const PLAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CATEGORY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let seq = 0;
function coupon(code: string, over: Partial<CouponFacts> = {}): CouponFacts {
  seq += 1;
  return {
    id: `coupon-${seq}`,
    code,
    discountType: DiscountType.percentage,
    discountValue: D(10),
    maxDiscountCap: null,
    minPurchaseAmount: null,
    totalUsageLimit: null,
    perUserUsageLimit: 1,
    usedCount: 0,
    reservedCount: 0,
    expiresAt: null,
    isActive: true,
    visibility: CouponVisibility.public,
    scopes: [],
    allowsUser: false,
    liveRedemptionsByUser: 0,
    ...over,
  };
}

const topUp = (amount: string, codes: string[]): CouponRequest => ({
  codes,
  amount: D(amount),
  target: { kind: 'wallet_top_up' },
});

const money = (r: ReturnType<typeof applyCoupons>) => ({
  applied: r.applied.map((a) => [a.code, a.discount.toFixed(2)]),
  rejected: r.rejected.map((x) => [x.code, x.reason]),
  totalDiscount: r.totalDiscount.toFixed(2),
  payable: r.payable.toFixed(2),
});

describe('stacking', () => {
  it('takes each discount from what the previous code left, in the order typed', () => {
    const coupons = [
      coupon('SIXTY', { discountValue: D(60) }),
      coupon('HALF', { discountValue: D(50) }),
    ];

    expect(money(applyCoupons(topUp('20.00', ['SIXTY', 'HALF']), coupons, NOW))).toEqual({
      applied: [['SIXTY', '12.00'], ['HALF', '4.00']],
      rejected: [],
      totalDiscount: '16.00',
      payable: '4.00',
    });
    // Order is the user's, not the lookup's: reversed, the same codes split differently.
    expect(money(applyCoupons(topUp('20.00', ['HALF', 'SIXTY']), coupons, NOW)).applied).toEqual([
      ['HALF', '10.00'],
      ['SIXTY', '6.00'],
    ]);
  });

  it('never takes the payable below zero, and a code with nothing left to take is refused', () => {
    const coupons = [
      coupon('BIG', { discountType: DiscountType.fixed_amount, discountValue: D('15.00') }),
      coupon('MORE', { discountType: DiscountType.fixed_amount, discountValue: D('1.00') }),
    ];

    expect(money(applyCoupons(topUp('10.00', ['BIG', 'MORE']), coupons, NOW))).toEqual({
      applied: [['BIG', '10.00']],
      rejected: [['MORE', 'nothing_to_discount']],
      totalDiscount: '10.00',
      payable: '0.00',
    });
  });

  it('caps a percentage at maxDiscountCap and rounds it down to the cent', () => {
    const coupons = [
      coupon('CAPPED', { discountValue: D(50), maxDiscountCap: D('3.00') }),
      coupon('THIRD', { discountValue: D('33.33') }),
    ];

    // 50% of 20 = 10, capped to 3; 33.33% of 17.00 = 5.6661, down to 5.66.
    expect(money(applyCoupons(topUp('20.00', ['CAPPED', 'THIRD']), coupons, NOW)).applied).toEqual([
      ['CAPPED', '3.00'],
      ['THIRD', '5.66'],
    ]);
  });

  it('lets a rejected code take nothing, so the next one sees the untouched payable', () => {
    const coupons = [
      coupon('GONE', { discountValue: D(90), expiresAt: new Date('2026-09-01T00:00:00Z') }),
      coupon('HALF', { discountValue: D(50) }),
    ];

    expect(money(applyCoupons(topUp('20.00', ['GONE', 'HALF']), coupons, NOW))).toEqual({
      applied: [['HALF', '10.00']],
      rejected: [['GONE', 'expired']],
      totalDiscount: '10.00',
      payable: '10.00',
    });
  });

  it('tests the minimum purchase against the amount, not against what earlier codes left', () => {
    const coupons = [
      coupon('SIXTY', { discountValue: D(60) }),
      coupon('MIN15', { discountValue: D(10), minPurchaseAmount: D('15.00') }),
    ];

    expect(money(applyCoupons(topUp('20.00', ['SIXTY', 'MIN15']), coupons, NOW)).applied).toEqual([
      ['SIXTY', '12.00'],
      ['MIN15', '0.80'],
    ]);
    expect(money(applyCoupons(topUp('14.99', ['MIN15']), coupons, NOW)).rejected).toEqual([
      ['MIN15', 'below_min_purchase'],
    ]);
  });
});

describe('normalizing codes', () => {
  it('trims, upper-cases, drops blanks and keeps the first of duplicates', () => {
    expect(normalizeCouponCodes([' save10 ', '', '  ', 'HALF', 'SAVE10', 'half'])).toEqual(['SAVE10', 'HALF']);
  });

  it('applies a code typed twice once', () => {
    const r = applyCoupons(topUp('20.00', ['half', 'HALF ']), [coupon('HALF', { discountValue: D(50) })], NOW);
    expect(money(r).applied).toEqual([['HALF', '10.00']]);
  });
});

describe('each gate refuses with its own reason', () => {
  const cases: Array<[string, Partial<CouponFacts>, string | null, CouponRequest['target']?]> = [
    ['unknown code', {}, 'not_found'],
    ['inactive', { isActive: false }, 'not_found'],
    ['targeted at someone else — indistinguishable from unknown', { visibility: CouponVisibility.targeted }, 'not_found'],
    ['targeted at this user', { visibility: CouponVisibility.targeted, allowsUser: true }, null],
    ['a gift code is not a discount (F-092-m)', { discountType: DiscountType.wallet_credit }, 'not_a_discount'],
    ['expired at this instant', { expiresAt: NOW }, 'expired'],
    ['expires later', { expiresAt: new Date('2026-09-11T12:00:01Z') }, null],
    ['scoped to a plan, used on a top-up', { scopes: [{ servicePlanId: PLAN, categoryId: null }] }, 'out_of_scope'],
    [
      'scoped to the category of the plan bought',
      { scopes: [{ servicePlanId: null, categoryId: CATEGORY }] },
      null,
      { kind: 'service', servicePlanId: 'other-plan', categoryId: CATEGORY },
    ],
    [
      'scoped to another plan and category',
      { scopes: [{ servicePlanId: PLAN, categoryId: null }] },
      'out_of_scope',
      { kind: 'service', servicePlanId: 'other-plan', categoryId: CATEGORY },
    ],
    ['per-user limit held by live redemptions', { perUserUsageLimit: 2, liveRedemptionsByUser: 2 }, 'per_user_limit_reached'],
    ['per-user limit above 1 with room left (D-21)', { perUserUsageLimit: 3, liveRedemptionsByUser: 2 }, null],
    ['a per-user limit of 0 is unlimited', { perUserUsageLimit: 0, liveRedemptionsByUser: 50 }, null],
    ['capacity taken by uses plus live reservations', { totalUsageLimit: 5, usedCount: 3, reservedCount: 2 }, 'capacity_reached'],
    ['one slot left', { totalUsageLimit: 5, usedCount: 3, reservedCount: 1 }, null],
    ['no total limit', { totalUsageLimit: null, usedCount: 10_000, reservedCount: 500 }, null],
  ];

  it.each(cases)('%s', (_name, over, reason, target = { kind: 'wallet_top_up' }) => {
    const known = _name === 'unknown code' ? [] : [coupon('CODE', over)];
    const r = applyCoupons({ codes: ['CODE'], amount: D('20.00'), target }, known, NOW);

    if (reason === null) {
      expect(r.rejected).toEqual([]);
      expect(r.applied.map((a) => a.discount.toFixed(2))).toEqual(['2.00']);
    } else {
      expect(r.rejected).toEqual([{ code: 'CODE', reason }]);
      expect(r.applied).toEqual([]);
      expect(r.payable.toFixed(2)).toBe('20.00');
    }
  });
});

describe('refused input', () => {
  it.each([
    ['a zero amount', topUp('0', ['X']), []],
    ['an amount finer than a cent', topUp('10.001', ['X']), []],
    ['a percentage above 100', topUp('10.00', ['X']), [coupon('X', { discountValue: D(101) })]],
    ['a negative fixed discount', topUp('10.00', ['X']), [coupon('X', { discountType: DiscountType.fixed_amount, discountValue: D(-1) })]],
  ])('throws on %s rather than pricing it', (_name, request, coupons) => {
    expect(() => applyCoupons(request, coupons, NOW)).toThrow(InvalidCouponInput);
  });
});
