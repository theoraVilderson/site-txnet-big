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
const VARIANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRODUCT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let seq = 0;
function coupon(code: string, over: Partial<CouponFacts> = {}): CouponFacts {
  seq += 1;
  return {
    id: `coupon-${seq}`,
    tenantId: TENANT,
    code,
    currencyCode: 'USD',
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
    deletedAt: null,
    validFrom: null,
    activeWeekdays: [],
    activeHourFrom: null,
    activeHourTo: null,
    maxPurchaseAmount: null,
    firstPurchaseOnly: false,
    newUserWithinDays: null,
    periodUsageLimit: null,
    periodDays: null,
    allowedChannels: [],
    gateways: [],
    liveRedemptionsInPeriod: 0,
    userCreatedAt: new Date('2026-01-01T00:00:00Z'),
    userHasPurchased: false,
    scopes: [],
    allowsUser: false,
    liveRedemptionsByUser: 0,
    ...over,
  };
}

const topUp = (amount: string, codes: string[]): CouponRequest => ({
  codes,
  amount: D(amount),
  currencyCode: 'USD',
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
    ['a free-service code is not a discount (F-502-l-a)', { discountType: DiscountType.free_grant }, 'not_a_discount'],
    ['expired at this instant', { expiresAt: NOW }, 'expired'],
    ['expires later', { expiresAt: new Date('2026-09-11T12:00:01Z') }, null],
    ['scoped to a variant, used on a top-up', { scopes: [{ productId: null, variantId: VARIANT }] }, 'out_of_scope'],
    [
      'scoped to the product of the variant bought',
      { scopes: [{ productId: PRODUCT, variantId: null }] },
      null,
      { kind: 'purchase', productId: PRODUCT, variantId: 'other-variant' },
    ],
    [
      'scoped to another variant and product',
      { scopes: [{ productId: null, variantId: VARIANT }] },
      'out_of_scope',
      { kind: 'purchase', productId: PRODUCT, variantId: 'other-variant' },
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
    const r = applyCoupons({ codes: ['CODE'], amount: D('20.00'), currencyCode: 'USD', target }, known, NOW);

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

describe('ownership (F-502-b, ADR-0048)', () => {
  const onGateway = (gatewaySource: 'platform' | 'tenant', codes = ['CODE']): CouponRequest => ({
    ...topUp('20.00', codes),
    gatewaySource,
  });

  it('refuses a soft-deleted coupon as unknown', () => {
    const r = applyCoupons(onGateway('platform'), [coupon('CODE', { deletedAt: NOW })], NOW);
    expect(r.rejected).toEqual([{ code: 'CODE', reason: 'not_found' }]);
  });

  it("refuses a platform coupon on a tenant's own gateway with its own reason", () => {
    const r = applyCoupons(onGateway('tenant'), [coupon('CODE', { tenantId: null })], NOW);
    expect(r.rejected).toEqual([{ code: 'CODE', reason: 'platform_coupon_needs_platform_gateway' }]);
  });

  it('applies a platform coupon on a platform gateway, and a tenant coupon on either', () => {
    expect(applyCoupons(onGateway('platform'), [coupon('CODE', { tenantId: null })], NOW).rejected).toEqual([]);
    expect(applyCoupons(onGateway('tenant'), [coupon('CODE')], NOW).rejected).toEqual([]);
    expect(applyCoupons(onGateway('platform'), [coupon('CODE')], NOW).rejected).toEqual([]);
  });

  it("prefers the tenant's own coupon when a platform coupon shares its code", () => {
    const own = coupon('CODE', { discountValue: D(50) });
    const platform = coupon('CODE', { tenantId: null, discountValue: D(10) });
    for (const rows of [[platform, own], [own, platform]]) {
      const r = applyCoupons(onGateway('tenant'), rows, NOW);
      expect(r.applied).toEqual([{ couponId: own.id, code: 'CODE', discount: D('10.00'), fx: null }]);
    }
  });

  it('ignores a soft-deleted twin and uses the live coupon of that code', () => {
    const gone = coupon('CODE', { deletedAt: NOW, discountValue: D(50) });
    const live = coupon('CODE', { tenantId: null });
    const r = applyCoupons(onGateway('platform'), [gone, live], NOW);
    expect(r.applied.map((a) => a.couponId)).toEqual([live.id]);
  });
});

describe('the limits of F-502-j each refuse with their own reason (F-502-k)', () => {
  // NOW is 2026-09-11T12:00:00Z: a Friday, 15:30 in Asia/Tehran (UTC+3:30).
  const GATEWAY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const on: Partial<CouponRequest> = { channel: 'panel', gatewaySource: 'tenant', gatewayId: GATEWAY };
  const cases: Array<[string, Partial<CouponFacts>, string | null, Partial<CouponRequest>?]> = [
    ['starts later', { validFrom: new Date('2026-09-11T12:00:01Z') }, 'not_started'],
    ['started at this instant', { validFrom: NOW }, null],
    ['only on Friday, in Tehran', { activeWeekdays: [5] }, null],
    ['only on Saturday and Sunday', { activeWeekdays: [6, 7] }, 'outside_window'],
    ['15:00-16:00 Tehran', { activeHourFrom: 15, activeHourTo: 16 }, null],
    ['16:00-17:00 Tehran', { activeHourFrom: 16, activeHourTo: 17 }, 'outside_window'],
    ['a window wrapping midnight that holds 15:30', { activeHourFrom: 14, activeHourTo: 2 }, null],
    ['a window wrapping midnight that misses 15:30', { activeHourFrom: 22, activeHourTo: 6 }, 'outside_window'],
    ['a maximum purchase below the amount', { maxPurchaseAmount: D('19.99') }, 'above_max_purchase'],
    ['a maximum purchase equal to the amount', { maxPurchaseAmount: D('20.00') }, null],
    ['first purchase only, for a user who has bought', { firstPurchaseOnly: true, userHasPurchased: true }, 'first_purchase_only'],
    ['first purchase only, for a user who has not', { firstPurchaseOnly: true }, null],
    ['new users within 7 days, for an older account', { newUserWithinDays: 7, userCreatedAt: new Date('2026-09-04T11:59:59Z') }, 'not_a_new_user'],
    ['new users within 7 days, for a 7-day-old account', { newUserWithinDays: 7, userCreatedAt: new Date('2026-09-04T12:00:00Z') }, null],
    ['new users only, for an account it cannot find', { newUserWithinDays: 7, userCreatedAt: null }, 'not_a_new_user'],
    ['two uses per 30 days, both taken', { periodUsageLimit: 2, periodDays: 30, liveRedemptionsInPeriod: 2 }, 'period_limit_reached'],
    ['two uses per 30 days, one taken', { periodUsageLimit: 2, periodDays: 30, liveRedemptionsInPeriod: 1 }, null],
    ['bot only, typed in the panel', { allowedChannels: ['bot'] }, 'wrong_channel'],
    ['panel or bot, typed in the panel', { allowedChannels: ['bot', 'panel'] }, null],
    ['limited to another gateway', { gateways: [{ gatewayId: null, tenantGatewayConfigId: 'other' }] }, 'wrong_gateway'],
    ['limited to this tenant gateway', { gateways: [{ gatewayId: null, tenantGatewayConfigId: GATEWAY }] }, null],
    [
      'limited to a platform gateway with the same id as this tenant one',
      { gateways: [{ gatewayId: GATEWAY, tenantGatewayConfigId: null }] },
      'wrong_gateway',
    ],
    ['a gateway limit when no gateway is named', { gateways: [{ gatewayId: null, tenantGatewayConfigId: GATEWAY }] }, 'wrong_gateway', { gatewayId: undefined, gatewaySource: undefined }],
    ['a channel limit when no channel is named', { allowedChannels: ['panel'] }, 'wrong_channel', { channel: undefined }],
  ];

  it.each(cases)('%s', (_name, over, reason, request = {}) => {
    const r = applyCoupons({ ...topUp('20.00', ['CODE']), ...on, ...request }, [coupon('CODE', over)], NOW);
    if (reason === null) {
      expect(r.rejected).toEqual([]);
    } else {
      expect(r.rejected).toEqual([{ code: 'CODE', reason }]);
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
