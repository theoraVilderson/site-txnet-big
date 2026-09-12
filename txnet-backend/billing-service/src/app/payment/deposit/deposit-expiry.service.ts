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
      where: { status: PaymentStatus.pending, expiresAt: { lte: now } },
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
    return { scanned: due.length, expired, unattributed };
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
          where: { id, status: PaymentStatus.pending, expiresAt: { lte: now } },
          data: { status: PaymentStatus.expired },
        });
        if (count !== 1) continue;
        await this.reservations.release(tx, id, RedemptionStatus.expired);
        expired++;
      }
      return expired;
    });
  }
}
