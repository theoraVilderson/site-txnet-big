import { CouponVisibility, DiscountType, Prisma } from '@prisma/client';
import { runInBoundTransaction, runWithTenant } from '@txnet-backend/shared-core';

import { CouponReservationService } from './coupon-reservation';
import { applyCoupons, CouponFacts, CouponRequest, CouponValidationService } from './coupon-validation';

/**
 * A coupon applies only in its own currency (F-116-h6, ADR-0098 part 3).
 *
 * The invariant: a coupon's money — a fixed value, a percentage's cap, the
 * purchase bounds — is in the coupon's `currencyCode`. On an order in another
 * currency (a platform USD coupon on a reseller's IRR order) each is converted
 * at the live rate, USD pivot, and the rate and its snapshots go on the
 * redemption; with no rate the coupon is refused. It is never read as if it
 * were in the order's currency: 2 dollars off is never 2 rials off.
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const NOW = new Date('2026-09-28T12:00:00Z');
const TENANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORDER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TO_LEG = '11111111-1111-4111-8111-111111111111';
const USD_IRR = { rate: D('1000000'), snapshotId: TO_LEG, fromSnapshotId: null };

let seq = 0;
function coupon(code: string, over: Partial<CouponFacts> = {}): CouponFacts {
  seq += 1;
  return {
    id: `coupon-${seq}`,
    tenantId: null,
    code,
    currencyCode: 'USD',
    discountType: DiscountType.fixed_amount,
    discountValue: D(2),
    maxDiscountCap: null,
    minPurchaseAmount: null,
    totalUsageLimit: null,
    perUserUsageLimit: 0,
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
    userCreatedAt: null,
    userHasPurchased: false,
    scopes: [],
    allowsUser: false,
    liveRedemptionsByUser: 0,
    fx: USD_IRR,
    ...over,
  };
}

/** As `tenantTransaction` leaves the scope: the tenant, and its binding on the transaction. */
const inTenantTransaction = <T>(fn: () => T): T =>
  runWithTenant({ id: TENANT } as never, () => runInBoundTransaction(TENANT, fn));

const irrOrder = (amount: string, codes: string[]): CouponRequest => ({
  codes,
  amount: D(amount),
  currencyCode: 'IRR',
  target: { kind: 'wallet_top_up' },
  gatewaySource: 'platform',
});

describe('a coupon in another currency than the order (F-116-h6)', () => {
  it('converts a fixed value at the live rate and says which rate it used', () => {
    const v = applyCoupons(irrOrder('10000000', ['USD2']), [coupon('USD2')], NOW);
    expect(v.applied).toEqual([{ couponId: expect.any(String), code: 'USD2', discount: D('2000000'), fx: USD_IRR }]);
    expect(v.payable.toFixed(2)).toBe('8000000.00');
  });

  it("converts a percentage's cap, and rounds a converted amount down to the cent", () => {
    const c = coupon('HALF', { discountType: DiscountType.percentage, discountValue: D(50), maxDiscountCap: D('1.5') });
    const pair = { rate: D('0.923456789'), snapshotId: TO_LEG, fromSnapshotId: null };
    const v = applyCoupons({ ...irrOrder('10', ['HALF']), currencyCode: 'EUR' }, [{ ...c, fx: pair }], NOW);
    // 50% of 10 is 5, capped at 1.5 USD = 1.3851851835 EUR -> 1.38.
    expect(v.applied[0].discount.toFixed(2)).toBe('1.38');
  });

  it('tests the purchase bounds in the order currency', () => {
    const c = () => coupon('MIN5', { minPurchaseAmount: D(5), maxPurchaseAmount: D(50) });
    expect(applyCoupons(irrOrder('4999999', ['MIN5']), [c()], NOW).rejected).toEqual([{ code: 'MIN5', reason: 'below_min_purchase' }]);
    expect(applyCoupons(irrOrder('5000000', ['MIN5']), [c()], NOW).applied).toHaveLength(1);
    expect(applyCoupons(irrOrder('50000001', ['MIN5']), [c()], NOW).rejected).toEqual([{ code: 'MIN5', reason: 'above_max_purchase' }]);
  });

  it('refuses a coupon with money and no rate, and the next code sees the untouched payable', () => {
    const v = applyCoupons(
      irrOrder('1000', ['USD2', 'OWN']),
      [coupon('USD2', { fx: null }), coupon('OWN', { tenantId: TENANT, currencyCode: 'IRR', fx: undefined, discountValue: D(100) })],
      NOW,
    );
    expect(v.rejected).toEqual([{ code: 'USD2', reason: 'currency_unavailable' }]);
    expect(v.applied).toEqual([{ couponId: expect.any(String), code: 'OWN', discount: D(100), fx: null }]);
  });

  it('applies a plain percentage with no rate: it carries no money to convert', () => {
    const c = coupon('TEN', { discountType: DiscountType.percentage, discountValue: D(10), fx: undefined });
    const v = applyCoupons(irrOrder('1000', ['TEN']), [c], NOW);
    expect(v.applied).toEqual([{ couponId: expect.any(String), code: 'TEN', discount: D(100), fx: null }]);
  });

  it('a fixed value that converts to less than a cent takes nothing', () => {
    const c = coupon('TINY', { discountValue: D('0.01'), fx: { rate: D('0.1'), snapshotId: null, fromSnapshotId: TO_LEG } });
    expect(applyCoupons({ ...irrOrder('10', ['TINY']), currencyCode: 'USD' }, [{ ...c, currencyCode: 'IRR' }], NOW).rejected).toEqual([
      { code: 'TINY', reason: 'nothing_to_discount' },
    ]);
  });
});

describe('the loader reads a rate only for a coupon that needs one', () => {
  it('asks once per coupon currency, from it to the order currency', async () => {
    const row = (code: string, over: Partial<CouponFacts>) => {
      const { scopes: _s, allowsUser: _a, liveRedemptionsByUser: _l, gateways: _g, liveRedemptionsInPeriod: _p, userCreatedAt: _u, userHasPurchased: _h, fx: _f, ...c } = coupon(code, over);
      return { ...c, serviceScopes: [], allowedUsers: [], gateways: [], _count: { redemptions: 0 } };
    };
    const tx = {
      coupon: {
        findMany: vi.fn().mockResolvedValue([
          row('A', {}),
          row('B', { discountValue: D(3) }),
          row('PCT', { discountType: DiscountType.percentage, discountValue: D(5) }),
          row('OWN', { tenantId: TENANT, currencyCode: 'IRR' }),
        ]),
      },
    } as unknown as Prisma.TransactionClient;
    const fx = { pair: vi.fn().mockResolvedValue(USD_IRR) };
    const service = new CouponValidationService(fx as never);

    const v = await inTenantTransaction(() => service.validate(tx, { ...irrOrder('100000000', ['A', 'B', 'PCT', 'OWN']), userId: USER }));

    expect(fx.pair).toHaveBeenCalledTimes(1);
    expect(fx.pair).toHaveBeenCalledWith('USD', 'IRR');
    expect(v.applied.map((a) => [a.code, a.discount.toFixed(2), a.fx])).toEqual([
      ['A', '2000000.00', USD_IRR],
      ['B', '3000000.00', USD_IRR],
      ['PCT', '4750000.00', null],
      ['OWN', '2.00', null],
    ]);
  });
});

describe('the redemption records the rate it was converted at', () => {
  it('passes the rate and both snapshots to reserve_coupon, and nulls for a coupon in the order currency', async () => {
    const calls: unknown[][] = [];
    const tx = {
      $queryRaw: vi.fn((_: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(values);
        return Promise.resolve([{ outcome: 'reserved' }]);
      }),
    } as unknown as Prisma.TransactionClient;

    await inTenantTransaction(() =>
      new CouponReservationService().reserve(tx, {
        userId: USER,
        orderReferenceId: ORDER,
        currencyCode: 'IRR',
        applied: [
          { couponId: 'a', code: 'USD2', discount: D('2000000'), fx: USD_IRR },
          { couponId: 'b', code: 'OWN', discount: D(100), fx: null },
        ],
      }),
    );

    expect(calls[0].slice(4)).toEqual(['2000000.00', 'IRR', '1000000', TO_LEG, null]);
    expect(calls[1].slice(4)).toEqual(['100.00', 'IRR', null, null, null]);
  });
});
