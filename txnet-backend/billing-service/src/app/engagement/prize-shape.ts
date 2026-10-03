import { Prisma, SpinPrizeType } from '@prisma/client';

/**
 * What a wheel slot and a lottery prize may give (ADR-0111 point 2), shared
 * by `WheelAdminService` (F-707-c) and `LotteryAdminService` (F-707-i) so the
 * two never disagree on what a prize is.
 *
 * The shape is the database's `engagement.prize_shape_ok`, answered here with
 * a reason instead of a 500. Never cash.
 */

export type PrizeShape = {
  prizeType: SpinPrizeType;
  prizeValue: Prisma.Decimal;
  couponTemplateId?: string | null;
  couponValidDays?: number | null;
  variantId?: string | null;
};

/** `engagement.prize_shape_ok`: GB > 0; whole days; a coupon's template + percent + days; a free Grant's variant; an empty slot 0. */
export function prizeShapeOk(p: PrizeShape): boolean {
  const template = p.couponTemplateId ?? null;
  const days = p.couponValidDays ?? null;
  const variant = p.variantId ?? null;
  const bare = template === null && days === null && variant === null;
  const value = p.prizeValue;
  switch (p.prizeType) {
    case SpinPrizeType.bonus_traffic_gb:
      return value.gt(0) && bare;
    case SpinPrizeType.extra_days:
      return value.gte(1) && value.isInteger() && bare;
    case SpinPrizeType.discount_coupon:
      return value.gt(0) && value.lte(100) && template !== null && days !== null && days >= 1 && variant === null;
    case SpinPrizeType.free_grant:
      return template === null && days === null && variant !== null;
    case SpinPrizeType.empty:
      return value.isZero() && bare;
    default:
      return false; // wallet_credit: never cash (ADR-0111 point 2)
  }
}

export type PrizeRelationMissing = { reason: 'coupon_template_not_found' | 'variant_not_found'; id: string };

/**
 * The first coupon template or variant a prize names that the tenant cannot
 * give: a template must be its own, not deleted, not a gift-code batch's; a
 * variant active. RLS hides another tenant's, so it is simply not found.
 */
export async function missingPrizeRelation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  prizes: Array<{ couponTemplateId?: string | null; variantId?: string | null }>,
): Promise<PrizeRelationMissing | null> {
  for (const p of prizes) {
    if (p.couponTemplateId) {
      const t = await tx.coupon.findFirst({ where: { id: p.couponTemplateId, tenantId, deletedAt: null, batchId: null }, select: { id: true } });
      if (!t) return { reason: 'coupon_template_not_found', id: p.couponTemplateId };
    }
    if (p.variantId) {
      const v = await tx.productVariant.findFirst({ where: { id: p.variantId, isActive: true }, select: { id: true } });
      if (!v) return { reason: 'variant_not_found', id: p.variantId };
    }
  }
  return null;
}
