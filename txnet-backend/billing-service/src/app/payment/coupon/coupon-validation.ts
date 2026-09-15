import { Injectable } from '@nestjs/common';
import { Coupon, CouponChannel, CouponVisibility, DiscountType, PaymentStatus, Prisma, RedemptionStatus } from '@prisma/client';
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
  /** Buying a variant: a scoped coupon applies when a scope row names this variant or its product (F-026-a). */
  | { kind: 'purchase'; productId: string; variantId: string };

export type CouponRequest = {
  /** As typed. Blank entries are dropped, the rest trimmed, upper-cased and de-duplicated. */
  codes: readonly string[];
  /** Base currency (ADR-0019), > 0, at most 2 decimal places. */
  amount: Prisma.Decimal;
  target: CouponTarget;
  /**
   * Whose gateway takes the payment. A platform coupon (`tenantId` null) is the
   * platform's money and applies only on a `platform` one (ADR-0048 decision 4);
   * a granted platform gateway is `platform`. Absent = no gateway is involved.
   */
  gatewaySource?: 'platform' | 'tenant';
  /** The gateway's id within `gatewaySource`; a coupon limited to gateways needs both. */
  gatewayId?: string;
  /** Where the code was typed; a coupon limited to channels needs it. */
  channel?: CouponChannel;
};

/** A coupon row, plus what the loader counted for this user. */
export type CouponFacts = Pick<
  Coupon,
  | 'id'
  | 'tenantId'
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
  | 'deletedAt'
  | 'validFrom'
  | 'activeWeekdays'
  | 'activeHourFrom'
  | 'activeHourTo'
  | 'maxPurchaseAmount'
  | 'firstPurchaseOnly'
  | 'newUserWithinDays'
  | 'periodUsageLimit'
  | 'periodDays'
  | 'allowedChannels'
> & {
  /** Its `coupon_service_scope` rows; none is an open scope. */
  scopes: Array<{ productId: string | null; variantId: string | null }>;
  /** A `coupon_allowed_user` row names this user. Matters only when `visibility` is `targeted`. */
  allowsUser: boolean;
  /** This user's `pending` + `confirmed` redemptions of it (billing invariant 6). */
  liveRedemptionsByUser: number;
  /** Its `coupon_gateway` rows; none is any gateway. */
  gateways: Array<{ gatewayId: string | null; tenantGatewayConfigId: string | null }>;
  /** Of those live redemptions, the ones inside its last `periodDays` days; 0 with no period. */
  liveRedemptionsInPeriod: number;
  /** When the user's account was made; null if it cannot be found. */
  userCreatedAt: Date | null;
  /** The user has a `success` payment (F-502-k: a top-up is a purchase until orders exist). */
  userHasPurchased: boolean;
};

export type CouponRejection =
  /** Unknown, inactive, soft-deleted, another tenant's, or targeted at someone else — never told apart. */
  | 'not_found'
  /** A `wallet_credit` coupon is a gift code, redeemed on its own (F-092-m). */
  | 'not_a_discount'
  /** A platform coupon typed on a tenant's own gateway (ADR-0048 decision 4). */
  | 'platform_coupon_needs_platform_gateway'
  | 'not_started'
  | 'expired'
  /** Outside its weekdays or hours, read in Asia/Tehran. */
  | 'outside_window'
  | 'wrong_channel'
  | 'wrong_gateway'
  | 'out_of_scope'
  | 'below_min_purchase'
  | 'above_max_purchase'
  | 'first_purchase_only'
  | 'not_a_new_user'
  | 'per_user_limit_reached'
  /** `periodUsageLimit` uses in the last `periodDays` days. */
  | 'period_limit_reached'
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
  if (!c.isActive || c.deletedAt) return 'not_found';
  if (c.visibility === CouponVisibility.targeted && !c.allowsUser) return 'not_found';
  // A gift code and a free-service code are redeemed in the gift box, not priced here (F-502-l-a).
  if (c.discountType === DiscountType.wallet_credit || c.discountType === DiscountType.free_grant) return 'not_a_discount';
  if (c.tenantId === null && request.gatewaySource === 'tenant') return 'platform_coupon_needs_platform_gateway';
  if (c.validFrom && now.getTime() < c.validFrom.getTime()) return 'not_started';
  if (c.expiresAt && now.getTime() >= c.expiresAt.getTime()) return 'expired';
  if (!inWindow(c, now)) return 'outside_window';
  if (c.allowedChannels.length > 0 && !(request.channel && c.allowedChannels.includes(request.channel))) {
    return 'wrong_channel';
  }
  if (!onGateway(c, request)) return 'wrong_gateway';
  if (!inScope(c, request.target)) return 'out_of_scope';
  if (c.minPurchaseAmount && request.amount.lt(c.minPurchaseAmount)) return 'below_min_purchase';
  if (c.maxPurchaseAmount && request.amount.gt(c.maxPurchaseAmount)) return 'above_max_purchase';
  if (c.firstPurchaseOnly && c.userHasPurchased) return 'first_purchase_only';
  if (c.newUserWithinDays != null && !isNewUser(c.userCreatedAt, c.newUserWithinDays, now)) return 'not_a_new_user';
  // 0 is unlimited — the user's answer 2026-09-11, as in legacy.
  if (c.perUserUsageLimit > 0 && c.liveRedemptionsByUser >= c.perUserUsageLimit) {
    return 'per_user_limit_reached';
  }
  if (c.periodUsageLimit != null && c.liveRedemptionsInPeriod >= c.periodUsageLimit) {
    return 'period_limit_reached';
  }
  if (c.totalUsageLimit != null && c.usedCount + c.reservedCount >= c.totalUsageLimit) {
    return 'capacity_reached';
  }
  return null;
}

/** Weekdays and hours are the tenant market's clock: Asia/Tehran, from the server's instant. */
export const COUPON_TIME_ZONE = 'Asia/Tehran';
const TEHRAN = new Intl.DateTimeFormat('en-US', {
  timeZone: COUPON_TIME_ZONE,
  weekday: 'short',
  hour: 'numeric',
  hourCycle: 'h23',
});
const ISO_WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function inWindow(c: CouponFacts, now: Date): boolean {
  if (c.activeWeekdays.length === 0 && c.activeHourFrom == null) return true;
  const parts = Object.fromEntries(TEHRAN.formatToParts(now).map((p) => [p.type, p.value]));
  if (c.activeWeekdays.length > 0 && !c.activeWeekdays.includes(ISO_WEEKDAY[parts['weekday']])) return false;
  if (c.activeHourFrom == null || c.activeHourTo == null) return true;
  const hour = Number(parts['hour']);
  // [from, to); from > to wraps midnight. The weekday is the one it is now, even past midnight.
  return c.activeHourFrom < c.activeHourTo
    ? hour >= c.activeHourFrom && hour < c.activeHourTo
    : hour >= c.activeHourFrom || hour < c.activeHourTo;
}

function onGateway(c: CouponFacts, request: CouponRequest): boolean {
  if (c.gateways.length === 0) return true;
  const { gatewaySource, gatewayId } = request;
  if (!gatewaySource || !gatewayId) return false;
  return c.gateways.some((g) =>
    gatewaySource === 'platform' ? g.gatewayId === gatewayId : g.tenantGatewayConfigId === gatewayId,
  );
}

const DAY_MS = 86_400_000;

function isNewUser(createdAt: Date | null, withinDays: number, now: Date): boolean {
  return createdAt != null && now.getTime() - createdAt.getTime() <= withinDays * DAY_MS;
}

function inScope(c: CouponFacts, target: CouponTarget): boolean {
  if (c.scopes.length === 0) return true;
  if (target.kind === 'wallet_top_up') return false;
  return c.scopes.some((s) => s.variantId === target.variantId || s.productId === target.productId);
}

/**
 * Which of two coupons sharing a code a user meant: a live one before a
 * soft-deleted one, then the tenant's own before a platform coupon serving it
 * (ADR-0048 decision 5). Lower wins.
 */
function rank(c: CouponFacts): number {
  return (c.deletedAt ? 2 : 0) + (c.tenantId === null ? 1 : 0);
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

  const byCode = new Map<string, CouponFacts>();
  for (const c of coupons) {
    const held = byCode.get(c.code);
    if (!held || rank(c) < rank(held)) byCode.set(c.code, c);
  }
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
   * registered model — the extension would filter out the platform's rows —
   * so what scopes it is its shared-read RLS policy (own tenant, or a platform
   * coupon that serves it — ADR-0048), and that binds only in a transaction that set `app.tenant_id`
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
            where: { code: { in: codes }, deletedAt: null },
            include: {
              serviceScopes: { select: { productId: true, variantId: true } },
              allowedUsers: { where: { userId }, select: { id: true }, take: 1 },
              gateways: { select: { gatewayId: true, tenantGatewayConfigId: true } },
              _count: { select: { redemptions: { where: { userId, status: { in: LIVE } } } } },
            },
          });

    // The user's facts, read once and only when a coupon asks for them.
    const now = new Date();
    const user =
      rows.some((c) => c.newUserWithinDays != null)
        ? await tx.user.findUnique({ where: { id: userId }, select: { createdAt: true } })
        : null;
    const userHasPurchased =
      rows.some((c) => c.firstPurchaseOnly) &&
      (await tx.paymentTransaction.count({ where: { userId, status: PaymentStatus.success }, take: 1 })) > 0;

    const facts: CouponFacts[] = [];
    for (const { serviceScopes, allowedUsers, gateways, _count, ...coupon } of rows) {
      const liveRedemptionsInPeriod =
        coupon.periodDays == null
          ? 0
          : await tx.couponRedemption.count({
              where: {
                couponId: coupon.id,
                userId,
                status: { in: LIVE },
                redeemedAt: { gt: new Date(now.getTime() - coupon.periodDays * DAY_MS) },
              },
            });
      facts.push({
        ...coupon,
        scopes: serviceScopes,
        allowsUser: allowedUsers.length > 0,
        liveRedemptionsByUser: _count.redemptions,
        gateways,
        liveRedemptionsInPeriod,
        userCreatedAt: user?.createdAt ?? null,
        userHasPurchased,
      });
    }
    return applyCoupons(request, facts, now);
  }
}
