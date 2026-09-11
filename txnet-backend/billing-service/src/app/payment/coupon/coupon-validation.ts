import { Injectable } from '@nestjs/common';
import { Coupon, CouponVisibility, DiscountType, Prisma, RedemptionStatus } from '@prisma/client';
import { TenantContext, TenantScopeConflict } from '@txnet-backend/shared-core';

/**
 * Which of the codes a user typed discount this purchase, and by how much
 * (F-092-g; D-21, D-23).
 *
 * Codes stack, in the order the user typed them, and each takes its discount
 * from what the codes before it left: 60% then 50% of 20 is 12 + 4. No code —
 * alone or stacked — takes the payable below zero. A code that fails a gate is
 * rejected with a closed reason and takes nothing, so the codes after it see
 * the payable as if it had not been typed. Everything stacked is what the
 * gateway calculator takes as `discount` (F-092-e).
 *
 * `applyCoupons` is the rule and is pure — no I/O, no clock, no float.
 * `CouponValidationService.validate` loads the facts it needs inside the
 * caller's `tenantTransaction`. It reserves nothing: capacity seen here is
 * advisory, and the reservation takes it atomically (F-092-h).
 *
 * Kept from the legacy `validateCoupons`: trim + upper-case + dedupe, a
 * percentage capped by `maxDiscountCap`, the minimum purchase tested against
 * the amount rather than the running payable. Not kept: Persian messages (a
 * `reason` the route maps to an i18n key, C-01), float rial arithmetic, and a
 * capacity check that ignored the user's own hold.
 */
export type CouponTarget =
  | { kind: 'wallet_top_up' }
  /** Buying a plan: a scoped coupon applies when a scope row names this plan or its category. */
  | { kind: 'service'; servicePlanId: string; categoryId: string };

export type CouponRequest = {
  /** As typed. Blank entries are dropped, the rest trimmed, upper-cased and de-duplicated. */
  codes: readonly string[];
  /** Base currency (ADR-0019), > 0, at most 2 decimal places. */
  amount: Prisma.Decimal;
  target: CouponTarget;
};

/** A coupon row, plus what the loader counted for this user. */
export type CouponFacts = Pick<
  Coupon,
  | 'id'
  | 'code'
  | 'discountType'
  | 'discountValue'
  | 'maxDiscountCap'
  | 'minPurchaseAmount'
  | 'totalUsageLimit'
  | 'perUserUsageLimit'
  | 'usedCount'
  | 'reservedCount'
  | 'expiresAt'
  | 'isActive'
  | 'visibility'
> & {
  /** Its `coupon_service_scope` rows; none is an open scope. */
  scopes: Array<{ servicePlanId: string | null; categoryId: string | null }>;
  /** A `coupon_allowed_user` row names this user. Matters only when `visibility` is `targeted`. */
  allowsUser: boolean;
  /** This user's `pending` + `confirmed` redemptions of it (billing invariant 6). */
  liveRedemptionsByUser: number;
};

export type CouponRejection =
  /** Unknown, inactive, another tenant's, or targeted at someone else — never told apart. */
  | 'not_found'
  /** A `wallet_credit` coupon is a gift code, redeemed on its own (F-092-m). */
  | 'not_a_discount'
  | 'expired'
  | 'out_of_scope'
  | 'below_min_purchase'
  | 'per_user_limit_reached'
  /** `usedCount + reservedCount` has reached `totalUsageLimit`. */
  | 'capacity_reached'
  /** The codes before it already took the payable to zero, or its discount rounds to nothing. */
  | 'nothing_to_discount';

export type AppliedCoupon = { couponId: string; code: string; discount: Prisma.Decimal };
export type RejectedCoupon = { code: string; reason: CouponRejection };

export type CouponValidation = {
  /** In the order typed. */
  applied: AppliedCoupon[];
  rejected: RejectedCoupon[];
  totalDiscount: Prisma.Decimal;
  /** `amount - totalDiscount`, never below zero. */
  payable: Prisma.Decimal;
};

/** Refused input or a broken coupon row. A caller or admin bug, never a user's mistake. */
export class InvalidCouponInput extends Error {
  constructor(reason: string) {
    super(`coupon validation: ${reason}`);
    this.name = 'InvalidCouponInput';
  }
}

/** `coupon` and `coupon_redemption` money columns are `Decimal(18, 2)`. */
const MONEY_SCALE = 2;
const ZERO = new Prisma.Decimal(0);
const LIVE: RedemptionStatus[] = [RedemptionStatus.pending, RedemptionStatus.confirmed];

export function normalizeCouponCodes(codes: readonly string[]): string[] {
  const normalized = codes.map((c) => c.trim().toUpperCase()).filter((c) => c.length > 0);
  return [...new Set(normalized)];
}

function gate(c: CouponFacts, request: CouponRequest, now: Date): CouponRejection | null {
  if (!c.isActive) return 'not_found';
  if (c.visibility === CouponVisibility.targeted && !c.allowsUser) return 'not_found';
  if (c.discountType === DiscountType.wallet_credit) return 'not_a_discount';
  if (c.expiresAt && now.getTime() >= c.expiresAt.getTime()) return 'expired';
  if (!inScope(c, request.target)) return 'out_of_scope';
  if (c.minPurchaseAmount && request.amount.lt(c.minPurchaseAmount)) return 'below_min_purchase';
  // 0 is unlimited — the user's answer 2026-09-11, as in legacy.
  if (c.perUserUsageLimit > 0 && c.liveRedemptionsByUser >= c.perUserUsageLimit) {
    return 'per_user_limit_reached';
  }
  if (c.totalUsageLimit != null && c.usedCount + c.reservedCount >= c.totalUsageLimit) {
    return 'capacity_reached';
  }
  return null;
}

function inScope(c: CouponFacts, target: CouponTarget): boolean {
  if (c.scopes.length === 0) return true;
  if (target.kind === 'wallet_top_up') return false;
  return c.scopes.some(
    (s) => s.servicePlanId === target.servicePlanId || s.categoryId === target.categoryId,
  );
}

/** The discount `c` takes from `running`, before the cap at `running`. */
function discountOf(c: CouponFacts, running: Prisma.Decimal): Prisma.Decimal {
  const value = c.discountValue;
  if (c.discountType === DiscountType.percentage) {
    if (value.lte(0) || value.gt(100)) {
      throw new InvalidCouponInput(`coupon ${c.code}: a percentage must be in (0, 100]`);
    }
    // Down to the cent: a discount rounded up would give away money no rule granted.
    let d = running.mul(value).div(100).toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_DOWN);
    if (c.maxDiscountCap && d.gt(c.maxDiscountCap)) d = c.maxDiscountCap;
    return d;
  }
  if (c.discountType === DiscountType.fixed_amount) {
    if (value.lte(0) || value.decimalPlaces() > MONEY_SCALE) {
      throw new InvalidCouponInput(`coupon ${c.code}: a fixed discount must be > 0 in cents`);
    }
    return value;
  }
  throw new InvalidCouponInput(`coupon ${c.code}: unknown discountType ${String(c.discountType)}`);
}

export function applyCoupons(
  request: CouponRequest,
  coupons: readonly CouponFacts[],
  now: Date,
): CouponValidation {
  const { amount } = request;
  if (amount.lte(0) || amount.decimalPlaces() > MONEY_SCALE) {
    throw new InvalidCouponInput(`amount must be > 0 with at most ${MONEY_SCALE} decimal places`);
  }

  const byCode = new Map(coupons.map((c) => [c.code, c]));
  const applied: AppliedCoupon[] = [];
  const rejected: RejectedCoupon[] = [];
  let running = amount;

  for (const code of normalizeCouponCodes(request.codes)) {
    const c = byCode.get(code);
    const reason = c ? gate(c, request, now) : 'not_found';
    if (!c || reason) {
      rejected.push({ code, reason: reason ?? 'not_found' });
      continue;
    }

    const discount = Prisma.Decimal.min(discountOf(c, running), running);
    if (discount.lte(0)) {
      rejected.push({ code, reason: 'nothing_to_discount' });
      continue;
    }
    running = running.minus(discount);
    applied.push({ couponId: c.id, code, discount });
  }

  return {
    applied,
    rejected,
    totalDiscount: amount.minus(running),
    payable: running.lt(0) ? ZERO : running,
  };
}

@Injectable()
export class CouponValidationService {
  /**
   * `tx` must come from `tenantTransaction(prisma, fn)`. `coupon` is not a
   * registered model — the extension would filter out the platform-wide rows —
   * so what scopes it is its shared-read RLS policy (own tenant or `tenantId`
   * NULL), and that binds only in a transaction that set `app.tenant_id`
   * first. On any other connection the read would not fail; it would quietly
   * see the platform's coupons alone, so it is refused here instead.
   */
  async validate(
    tx: Prisma.TransactionClient,
    request: CouponRequest & { userId: string },
  ): Promise<CouponValidation> {
    const tenant = TenantContext.current('coupon validation');
    if (TenantContext.transactionTenantId() !== tenant.id) {
      throw new TenantScopeConflict('coupon validation outside tenantTransaction()', tenant.id);
    }

    const codes = normalizeCouponCodes(request.codes);
    const { userId } = request;
    const rows =
      codes.length === 0
        ? []
        : await tx.coupon.findMany({
            where: { code: { in: codes } },
            include: {
              serviceScopes: { select: { servicePlanId: true, categoryId: true } },
              allowedUsers: { where: { userId }, select: { id: true }, take: 1 },
              _count: { select: { redemptions: { where: { userId, status: { in: LIVE } } } } },
            },
          });

    const facts = rows.map(({ serviceScopes, allowedUsers, _count, ...coupon }) => ({
      ...coupon,
      scopes: serviceScopes,
      allowsUser: allowedUsers.length > 0,
      liveRedemptionsByUser: _count.redemptions,
    }));
    return applyCoupons(request, facts, new Date());
  }
}
