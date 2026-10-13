/**
 * A reseller's coupons give at most its `coupon_discount_pct_max` (F-904,
 * ADR-0106), refused at create, edit and batch create.
 *
 * What breaks without anyone seeing it:
 *  - **a free service slipping past the cap.** It is a 100% discount, so a cap
 *    under 100 refuses it, one code or a batch (user 2026-10-13);
 *  - **money counted as a discount.** A wallet credit is money, not a
 *    discount, and is never read;
 *  - **a fixed amount past the cap.** It has no price at create, so it is
 *    weighed against its minimum purchase: at most the cap's share of it, and
 *    with no minimum it could be the whole price (F-904-a, user 2026-10-14);
 *  - **an old coupon locked.** An edit that leaves the discount as it was is
 *    never refused, even over a cap lowered since — only a new discount is;
 *  - **platform staff refused.** Acting on a reseller's coupon they pass, as
 *    every reseller limit; a platform coupon has no reseller at all.
 */
import { DiscountType } from '@prisma/client';
import { ResellerLimitReached } from '@txnet-backend/shared-core';

import { assertUnderDiscountCap } from './coupon-discount-cap';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';

function fakeTx(cap: number | null) {
  const reads: string[] = [];
  const tx = {
    tenant: { findUnique: async () => (reads.push('limit'), { tenantType: 'reseller' }) },
    tenantSubscription: { findUnique: async () => null },
    resellerLimit: { findMany: async () => [] },
    packageLimit: { findMany: async () => [] },
    resellerLimitSetting: { findMany: async () => (cap === null ? [] : [{ key: 'coupon_discount_pct_max', value: cap }]) },
  };
  return { tx, reads };
}

const own = { actorTenantId: RESELLER, tenantId: RESELLER };
const pct = (value: string) => ({ discountType: DiscountType.percentage, discountValue: value });
const freeService = { discountType: DiscountType.free_grant, discountValue: '0' };

describe('assertUnderDiscountCap (F-904)', () => {
  it('refuses a percentage above the cap, naming the key, the cap and the percentage', async () => {
    const { tx } = fakeTx(30);
    const e = await assertUnderDiscountCap(tx as never, { ...own, next: pct('40') }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ResellerLimitReached);
    expect(e).toMatchObject({ key: 'coupon_discount_pct_max', limit: 30, used: 40 });
    await expect(assertUnderDiscountCap(tx as never, { ...own, next: pct('30') })).resolves.toBeUndefined();
  });

  it('counts a free service as 100%: under a cap below 100 it is refused, with no cap it passes', async () => {
    await expect(assertUnderDiscountCap(fakeTx(99).tx as never, { ...own, next: freeService })).rejects.toMatchObject({ used: 100 });
    await expect(assertUnderDiscountCap(fakeTx(null).tx as never, { ...own, next: freeService })).resolves.toBeUndefined();
  });

  it('reads nothing for a wallet credit: it is money, not a discount', async () => {
    const { tx, reads } = fakeTx(1);
    await assertUnderDiscountCap(tx as never, { ...own, next: { discountType: DiscountType.wallet_credit, discountValue: '50' } });
    expect(reads).toEqual([]);
  });

  it('weighs a fixed amount against its minimum purchase: at most the cap\'s share of it (F-904-a)', async () => {
    const { tx } = fakeTx(30);
    const fixed = (value: string, min: string | null) => ({ discountType: DiscountType.fixed_amount, discountValue: value, minPurchaseAmount: min });
    await expect(assertUnderDiscountCap(tx as never, { ...own, next: fixed('30000', '100000') })).resolves.toBeUndefined();
    await expect(assertUnderDiscountCap(tx as never, { ...own, next: fixed('30000', '50000') })).rejects.toMatchObject({ key: 'coupon_discount_pct_max', limit: 30, used: 60 });
    // No minimum: it could be the whole price.
    await expect(assertUnderDiscountCap(tx as never, { ...own, next: fixed('1000', null) })).rejects.toMatchObject({ used: 100 });
    // Lowering the minimum is a new discount, asked again.
    await expect(assertUnderDiscountCap(tx as never, { ...own, next: fixed('30000', '50000'), before: fixed('30000', '100000') })).rejects.toBeInstanceOf(ResellerLimitReached);
    await expect(assertUnderDiscountCap(fakeTx(null).tx as never, { ...own, next: fixed('1000', null) })).resolves.toBeUndefined();
  });

  it('never refuses an edit that leaves the discount as it was', async () => {
    const { tx, reads } = fakeTx(10);
    await expect(assertUnderDiscountCap(tx as never, { ...own, next: pct('50'), before: pct('50.00') })).resolves.toBeUndefined();
    expect(reads).toEqual([]);
    await expect(assertUnderDiscountCap(tx as never, { ...own, next: pct('60'), before: pct('50') })).rejects.toBeInstanceOf(ResellerLimitReached);
  });

  it('lets platform staff pass, and asks nothing of a platform coupon', async () => {
    const { tx, reads } = fakeTx(10);
    await assertUnderDiscountCap(tx as never, { actorTenantId: PLATFORM, tenantId: RESELLER, next: pct('90') });
    await assertUnderDiscountCap(tx as never, { actorTenantId: PLATFORM, tenantId: null, next: freeService });
    expect(reads).toEqual([]);
  });
});
