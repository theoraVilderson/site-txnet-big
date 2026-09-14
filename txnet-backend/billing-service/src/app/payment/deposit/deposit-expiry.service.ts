import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus, RedemptionStatus } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../../config/env.validation';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CouponReservationService } from '../coupon/coupon-reservation';

/**
 * The clock on a pending top-up, and the capacity it is holding (F-092-k).
 *
 * `DepositStartService` writes a `pending` payment with `expiresAt` and a
 * `pending` coupon hold per applied code. `DepositCallbackService` settles the
 * ones a payer came back for. This is what happens to the rest — a payer who
 * closed the tab at the bank, a gateway that minted an authority nobody used —
 * and without it every abandoned top-up holds a slot of somebody's coupon
 * capacity for ever.
 *
 * **It replaces two Mongo TTL indexes, and does the opposite of what they did.**
 * Legacy expired a `Transactions` row and a `CouponLocks` row by *deleting*
 * them, on two separate clocks, so a lock could outlive its payment and an
 * abandoned payment left no trace that it had ever been attempted. Here there
 * is one clock, the row stays, and the only thing that changes is its status
 * and its holds.
 *
 * **The scan is cross-tenant; every write is not.** Which tenants have a due
 * payment is what this job is looking for, so the read cannot be scoped by one
 * — and on the application pool it would answer nothing at all, because
 * `payment_transaction`'s RLS policy shows a connection with no `app.tenant_id`
 * zero rows. The writes then run one tenant at a time, inside
 * `tenantTransaction`, because the coupon SQL functions scope by exactly that
 * binding (`coupon-reservation.ts`).
 *
 * **The flip is status-guarded, like the callback's.** A bank can confirm a
 * payment between this job's scan and its write: `updateMany({ status: pending
 * })` then matches nothing, the release hangs off its `count`, and a confirmed
 * use never has its slot given back. That guard is also what makes the job safe
 * to run twice, which the at-least-once tick (ADR-0027) requires.
 *
 * **A hold is released `expired`, never `cancelled`.** Nothing here failed —
 * the clock ran out. `DepositCallbackService.close()` owns the other word, and
 * the two stay distinguishable in `coupon_redemption` precisely so that an
 * audit can tell an abandoned payment from a refused one.
 *
 * **The clock closes the payment, not its coupons** (F-092-ah, ADR-0047
 * decision 2). A bank may still charge a payment after its clock, and a slot
 * handed to someone else meanwhile is how a late credit took a coupon past its
 * limit. So the flip keeps the holds, and a second pass gives them back only
 * once the payment has been `expired` for `COUPON_HOLD_AFTER_EXPIRY_SEC` —
 * under a row lock that still finds it `expired`, so a late credit racing the
 * release either waits for it (and claims the uses back) or has already
 * confirmed them (and the release moves nothing).
 */

/** What one sweep did. Every number is reported, including the one nothing can act on. */
export type DepositExpiryResult = {
  /** Rows the cross-tenant scan found due, at most one batch. */
  scanned: number;
  /** Rows that were still `pending` when the guarded flip ran. */
  expired: number;
  /**
   * Due rows carrying no `tenantId`. The application pool cannot write them —
   * RLS scopes by that column — so they are counted and logged rather than
   * passed over, because a payment nothing can ever expire is a schema fault
   * (`withTenant` injects the column on create) and not a quiet zero.
   */
  unattributed: number;
  /** Expired payments whose coupon holds this sweep gave back, past `COUPON_HOLD_AFTER_EXPIRY_SEC` (F-092-ah). */
  holdsReleased: number;
};

@Injectable()
export class DepositExpiryService {
  private readonly logger = new Logger(DepositExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly reservations: CouponReservationService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  async expirePending(): Promise<DepositExpiryResult> {
    // One `now` for the scan and for every guard below it, so a row that was
    // due when it was read cannot be spared by the clock moving mid-sweep.
    const now = new Date();
    const take = this.config.get('PAYMENT_EXPIRY_BATCH_SIZE', { infer: true });

    const due = await this.crossTenant.paymentTransaction.findMany({
      // A verifying row is skipped (F-092-x, ADR-0044 decision 4): the gateway
      // may have the money, so its holds stay until a settled answer or a
      // person closes it.
      where: { status: PaymentStatus.pending, expiresAt: { lte: now }, nextVerifyAt: null },
      select: { id: true, tenantId: true },
      // Oldest first: a backlog larger than one batch drains in the order it
      // accumulated, and no row can be starved by newer ones arriving.
      orderBy: { expiresAt: 'asc' },
      take,
    });

    const byTenant = new Map<string, string[]>();
    let unattributed = 0;
    for (const row of due) {
      if (!row.tenantId) {
        unattributed++;
        continue;
      }
      const ids = byTenant.get(row.tenantId);
      if (ids) ids.push(row.id);
      else byTenant.set(row.tenantId, [row.id]);
    }

    if (unattributed > 0) {
      this.logger.error(
        `${unattributed} due payment(s) carry no tenantId and cannot be expired; ` +
          `withTenant should make that impossible on create`,
      );
    }

    let expired = 0;
    for (const [tenantId, ids] of byTenant) {
      expired += await runWithTenant({ id: tenantId }, () => this.expireForTenant(ids, now));
    }

    if (expired > 0) this.logger.log(`expired ${expired} pending payment(s)`);

    const holdsReleased = await this.releaseLapsedHolds(now, take);
    if (holdsReleased > 0) this.logger.log(`gave back the coupon holds of ${holdsReleased} expired payment(s)`);
    return { scanned: due.length, expired, unattributed, holdsReleased };
  }

  /**
   * The second pass: expired payments still holding coupons, expired longer
   * than `COUPON_HOLD_AFTER_EXPIRY_SEC`. One transaction per payment, each
   * taking the row lock a crediting flip would wait on.
   */
  private async releaseLapsedHolds(now: Date, take: number): Promise<number> {
    const holdSec = this.config.get('COUPON_HOLD_AFTER_EXPIRY_SEC', { infer: true });
    const lapsed = await this.crossTenant.paymentTransaction.findMany({
      where: {
        status: PaymentStatus.expired,
        expiresAt: { lte: new Date(now.getTime() - holdSec * 1000) },
        couponRedemptions: { some: { status: RedemptionStatus.pending } },
      },
      select: { id: true, tenantId: true },
      orderBy: { expiresAt: 'asc' },
      take,
    });

    let released = 0;
    for (const { id, tenantId } of lapsed) {
      // A row with no tenant was never expired by this job; the first scan reports that fault.
      if (!tenantId) continue;
      released += await runWithTenant({ id: tenantId }, () =>
        tenantTransaction(this.prisma, async (tx) => {
          const locked = await tx.$queryRaw<unknown[]>`
            SELECT 1 FROM "billing"."payment_transaction"
             WHERE "id" = ${id}::uuid AND "status" = 'expired'
               FOR UPDATE`;
          if (locked.length === 0) return 0;
          await this.reservations.release(tx, id, RedemptionStatus.expired);
          return 1;
        }),
      );
    }
    return released;
  }

  /**
   * One tenant's due payments, in one transaction.
   *
   * Per payment rather than one `updateMany` over the batch, because the
   * release has to know **which** rows actually flipped: a batch update answers
   * a count and not a list, and releasing the holds of a payment that a
   * callback confirmed a moment earlier would hand back capacity a real use is
   * holding. The transaction stays bounded because the scan is.
   */
  private expireForTenant(ids: readonly string[], now: Date): Promise<number> {
    return tenantTransaction(this.prisma, async (tx) => {
      let expired = 0;
      for (const id of ids) {
        const { count } = await tx.paymentTransaction.updateMany({
          // `expiresAt` is in the guard as well as the status: the row was read
          // outside this transaction, and a payment whose clock was extended
          // between the two is not this job's to close.
          //
          // `expiresAt` is deliberately **not** cleared, unlike the callback's
          // flip to `success` and `close()`'s to `failed`. Those are final; an
          // expired payment is still inquired at the gateway by F-092-l, and
          // when we stopped waiting is part of what a mismatch is judged on.
          where: { id, status: PaymentStatus.pending, expiresAt: { lte: now }, nextVerifyAt: null },
          data: { status: PaymentStatus.expired },
        });
        // The holds stay: `releaseLapsedHolds` gives them back later (F-092-ah).
        if (count === 1) expired++;
      }
      return expired;
    });
  }
}
