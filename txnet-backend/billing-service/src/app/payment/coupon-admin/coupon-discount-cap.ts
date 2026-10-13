import { DiscountType, Prisma } from '@prisma/client';
import { ResellerLimitReached, resellerLimitOf } from '@txnet-backend/shared-core';

/** A coupon's discount as it is being written or was stored: its type and value (a decimal string). */
export type CouponDiscount = { discountType?: unknown; discountValue?: unknown };

const WHOLE = new Prisma.Decimal(100);

/**
 * The discount as a percentage of a price: a percentage's own value, a free
 * service's 100. `null` for money — a wallet credit is not a discount, and a
 * fixed amount has no price to compare to until it is redeemed (F-904,
 * user 2026-10-13: its own row).
 */
export function discountPctOf(c: CouponDiscount): Prisma.Decimal | null {
  if (c.discountType === DiscountType.free_grant) return WHOLE;
  if (c.discountType !== DiscountType.percentage) return null;
  return new Prisma.Decimal(String(c.discountValue));
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
  if (limit !== null && pct.greaterThan(limit)) throw new ResellerLimitReached('coupon_discount_pct_max', limit, pct.toNumber());
}
