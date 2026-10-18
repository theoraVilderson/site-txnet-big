import { DiscountType, Prisma } from '@prisma/client';
import { inCurrency, operatingCurrencyOf, platformCurrencyOf } from '@txnet-backend/shared-core';

/** A percentage coupon's value is told to two places: 12.50%. */
const PERCENT_PLACES = 2;

const decimalOf = (v: unknown): Prisma.Decimal | null => (v === null || v === undefined || v === '' ? null : new Prisma.Decimal(String(v)));

/**
 * A coupon's money — a fixed value or a gift code's credit, a percentage's
 * cap, the purchase bounds — is in the coupon's currency and refused finer than
 * its places (F-116-r); a percentage keeps its two. The first field that does
 * not fit is refused with the write's own `refuse`, so a value no order can be
 * discounted by never reaches a checkout. Answers `currencyCode`.
 */
export async function couponInCurrency(tx: Pick<Prisma.TransactionClient, 'currency'>, currencyCode: string, coupon: Record<string, unknown>, refuse: (field: string) => Error): Promise<string> {
  const percent = coupon['discountType'] === DiscountType.percentage;
  const value = decimalOf(coupon['discountValue']);
  if (percent && value && value.decimalPlaces() > PERCENT_PLACES) throw refuse('discountValue');
  const money = {
    discountValue: percent ? null : value,
    maxDiscountCap: decimalOf(coupon['maxDiscountCap']),
    minPurchaseAmount: decimalOf(coupon['minPurchaseAmount']),
    maxPurchaseAmount: decimalOf(coupon['maxPurchaseAmount']),
  };
  return inCurrency(tx, currencyCode, money, refuse);
}

/** The currency a new coupon or gift batch of `tenantId` is written in: a platform one (`null`) in the platform's, a tenant's in its own (F-116-b). */
export const couponCurrencyOf = (tx: Prisma.TransactionClient, tenantId: string | null): Promise<string> => (tenantId ? operatingCurrencyOf(tx, tenantId) : platformCurrencyOf(tx));
