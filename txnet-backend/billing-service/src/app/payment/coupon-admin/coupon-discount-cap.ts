import { DiscountType, Prisma } from '@prisma/client';
import { ResellerLimitReached, resellerLimitOf, roundRatio } from '@txnet-backend/shared-core';

/** A coupon's discount as it is being written or was stored: its type, value and minimum purchase (decimal strings). */
export type CouponDiscount = { discountType?: unknown; discountValue?: unknown; minPurchaseAmount?: unknown };

const WHOLE = new Prisma.Decimal(100);
/** A share of the price is told to two places: 33.33. */
const PERCENT_PLACES = 2;

/**
 * The most a coupon can take off a price, as a percentage of it: a
 * percentage's own value, a free service's 100. A fixed amount has no price
 * at create, so it is weighed against its minimum purchase — the smallest
 * price it applies to, both in the coupon's currency — and with none it could
 * be the whole price (F-904-a, user 2026-10-14). `null` for a wallet credit:
 * money, not a discount.
 */
export function discountPctOf(c: CouponDiscount): Prisma.Decimal | null {
  if (c.discountType === DiscountType.free_grant) return WHOLE;
  if (c.discountType === DiscountType.percentage) return new Prisma.Decimal(String(c.discountValue));
  if (c.discountType !== DiscountType.fixed_amount) return null;
  const min = c.minPurchaseAmount === null || c.minPurchaseAmount === undefined || c.minPurchaseAmount === '' ? null : new Prisma.Decimal(String(c.minPurchaseAmount));
  if (!min || !min.isPositive() || min.isZero()) return WHOLE;
  return new Prisma.Decimal(String(c.discountValue)).div(min).mul(WHOLE);
}

const sameDiscount = (a: CouponDiscount, b: CouponDiscount): boolean => {
  if (a.discountType !== b.discountType) return false;
  const x = discountPctOf(a);
  const y = discountPctOf(b);
  return x === null || y === null || x.equals(y);
};

/**
 * A reseller's coupon gives at most its `coupon_discount_pct_max` (F-904,
 * ADR-0106): refused `reseller_limit_reached` with the cap and the percentage.
 * Asked of a new discount only — an edit that leaves it as it was passes, so
 * a coupon made before the cap was lowered stays editable. Platform staff
 * acting on a reseller's coupon pass, as every reseller limit (user
 * 2026-10-13); a platform coupon (`tenantId` null) has no reseller.
 */
export async function assertUnderDiscountCap(
  tx: Prisma.TransactionClient,
  c: { actorTenantId: string; tenantId: string | null; next: CouponDiscount; before?: CouponDiscount | null },
): Promise<void> {
  if (c.tenantId === null || c.actorTenantId !== c.tenantId) return;
  if (c.before && sameDiscount(c.next, c.before)) return;
  const pct = discountPctOf(c.next);
  if (pct === null) return;
  const { limit } = await resellerLimitOf(tx, c.tenantId, 'coupon_discount_pct_max');
  // `used` is shown to the reseller: a fixed amount's share is rounded to two places (33.33, not 33.333…).
  if (limit !== null && pct.greaterThan(limit)) throw new ResellerLimitReached('coupon_discount_pct_max', limit, roundRatio(pct, PERCENT_PLACES).toNumber());
}
