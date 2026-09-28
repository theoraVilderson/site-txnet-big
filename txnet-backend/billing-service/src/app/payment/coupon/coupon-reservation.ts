import { Injectable } from '@nestjs/common';
import { Prisma, RedemptionStatus } from '@prisma/client';
import { TenantContext, TenantScopeConflict } from '@txnet-backend/shared-core';

import { AppliedCoupon, CouponRejection, InvalidCouponInput } from './coupon-validation';

/**
 * Holds, uses and gives back what coupon validation applied (F-092-h, ADR-0040).
 *
 * `reserve` takes one `pending` `coupon_redemption` per applied coupon and one
 * slot of its `reservedCount`; `confirm` turns an order's holds into uses;
 * `release` gives them back. All three are SQL functions from migration
 * `20260911000200_coupon_reservation`, because a tenant's connection may read a
 * platform coupon but its RLS refuses any update of it.
 *
 * Kept from the legacy `reserveCoupons` / `commitCoupons` / `releaseLocks`: a
 * hold per code, confirmed on payment, released on failure. Not kept: the
 * count-then-upsert that let two buyers take the last slot, the `usedBy`
 * array (now redemption rows), and the lock's own 20-minute TTL — a hold lives
 * as long as its payment, which F-092-k expires.
 */
export type CouponReservation = {
  /** From `X-User-Id`, as for the ledger. */
  userId: string;
  /** The order the holds belong to; `confirm` and `release` name it. For a top-up, the payment's id. */
  orderReferenceId: string;
  paymentTransactionId?: string | null;
  /**
   * The order's currency, which every held discount is in; each redemption
   * records it (F-116-h5), and the rate a coupon in another currency was
   * converted at (`AppliedCoupon.fx`, F-116-h6).
   */
  currencyCode: string;
  /** `CouponValidation.applied`, as validated in this same transaction. */
  applied: readonly AppliedCoupon[];
};

/** A coupon that validated but can no longer be held. The caller's transaction must not commit. */
export class CouponReservationRefused extends Error {
  constructor(
    readonly code: string,
    readonly reason: CouponRejection,
  ) {
    super(`coupon ${code} could not be reserved: ${reason}`);
    this.name = 'CouponReservationRefused';
  }
}

const REFUSALS: readonly CouponRejection[] = [
  'not_found',
  'not_a_discount',
  'not_started',
  'expired',
  'currency_unavailable',
  'first_purchase_only',
  'per_user_limit_reached',
  'period_limit_reached',
  'capacity_reached',
];

@Injectable()
export class CouponReservationService {
  /**
   * Holds every applied coupon, or throws `CouponReservationRefused` for the
   * first that cannot be held. The holds before it are already written: the
   * refusal must abort the whole transaction, and the route re-quotes.
   */
  async reserve(tx: Prisma.TransactionClient, reservation: CouponReservation): Promise<void> {
    assertTenantTransaction('coupon reservation');
    const { userId, orderReferenceId, currencyCode } = reservation;
    const paymentTransactionId = reservation.paymentTransactionId ?? null;

    // Coupon id order, so two orders stacking the same codes lock them alike and never deadlock.
    const byLockOrder = [...reservation.applied].sort((a, b) => a.couponId.localeCompare(b.couponId));
    for (const { couponId, code, discount, fx } of byLockOrder) {
      if (discount.lte(0) || discount.decimalPlaces() > 2) {
        throw new InvalidCouponInput(`coupon ${code}: a held discount must be > 0 in cents`);
      }
      const [{ outcome }] = await tx.$queryRaw<Array<{ outcome: string }>>`
        SELECT billing.reserve_coupon(
          ${couponId}::uuid, ${userId}::uuid, ${orderReferenceId}::uuid,
          ${paymentTransactionId}::uuid, ${discount.toFixed(2)}::numeric, ${currencyCode}::text,
          ${fx ? fx.rate.toFixed() : null}::numeric, ${fx?.snapshotId ?? null}::uuid, ${fx?.fromSnapshotId ?? null}::uuid
        ) AS outcome`;
      if (outcome === 'reserved') continue;
      if (!REFUSALS.includes(outcome as CouponRejection)) {
        throw new Error(`reserve_coupon answered an unknown outcome: ${outcome}`);
      }
      throw new CouponReservationRefused(code, outcome as CouponRejection);
    }
  }

  /** The order's pending holds become uses. Returns how many moved; a repeat moves none. */
  confirm(tx: Prisma.TransactionClient, orderReferenceId: string): Promise<number> {
    return this.settle(tx, orderReferenceId, RedemptionStatus.confirmed);
  }

  /**
   * A payment credited after its clock ran out (ADR-0046 decision 1): the
   * holds the clock released `expired` become uses again. The slots were given
   * back, so this may take a coupon past its limit — the payer was charged the
   * discounted price, and the discount is honoured. Returns how many moved.
   */
  async claimExpired(tx: Prisma.TransactionClient, orderReferenceId: string): Promise<number> {
    assertTenantTransaction('coupon claim');
    const [{ moved }] = await tx.$queryRaw<Array<{ moved: number }>>`
      SELECT billing.claim_expired_coupon_redemptions(${orderReferenceId}::uuid) AS moved`;
    return moved;
  }

  /**
   * The order's pending holds give their slots back — `cancelled` when the
   * payment failed, `expired` when it timed out. A confirmed use is never
   * released.
   */
  release(
    tx: Prisma.TransactionClient,
    orderReferenceId: string,
    outcome: typeof RedemptionStatus.cancelled | typeof RedemptionStatus.expired,
  ): Promise<number> {
    return this.settle(tx, orderReferenceId, outcome);
  }

  private async settle(
    tx: Prisma.TransactionClient,
    orderReferenceId: string,
    outcome: RedemptionStatus,
  ): Promise<number> {
    assertTenantTransaction('coupon settlement');
    const [{ moved }] = await tx.$queryRaw<Array<{ moved: number }>>`
      SELECT billing.settle_coupon_redemptions(
        ${orderReferenceId}::uuid, ${outcome}::billing."RedemptionStatus"
      ) AS moved`;
    return moved;
  }
}

/**
 * The functions scope by the `app.tenant_id` a `tenantTransaction` binds.
 * Unbound they would refuse; bound to another tenant they would see the wrong
 * coupons — so both are refused here, before the database is asked.
 */
function assertTenantTransaction(what: string) {
  const tenant = TenantContext.current(what);
  if (TenantContext.transactionTenantId() !== tenant.id) {
    throw new TenantScopeConflict(`${what} outside tenantTransaction()`, tenant.id);
  }
}
