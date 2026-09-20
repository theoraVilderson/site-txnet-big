import { Injectable } from '@nestjs/common';
import { PaymentStatus, RedemptionStatus } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { CouponReservationService } from '../coupon/coupon-reservation';
import { PaymentProviderRegistry } from '../gateway/payment-provider.registry';
import { gatewayRefOf, PAYMENT_SELECT } from './deposit-settlement';

/**
 * A Mini App top-up the payer never went through with (F-093-q).
 *
 * `start` has already written the `pending` payment and held a slot of every
 * coupon applied to it by the time the messenger's invoice sheet opens
 * (F-104-o). When that sheet closes `cancelled`, `failed`, or never opens at
 * all, nothing on the way back released those holds: the expiry sweep did,
 * `PAYMENT_PENDING_TTL_SEC` later. A one-use code — the default `per_user`
 * limit is 1 — therefore answered `per_user_limit_reached` on the retry the
 * payer made a second later, for a payment nobody ever charged.
 *
 * So the page says so. This is `DepositCallbackService.close()` for a payment
 * with no bank to ask: `failed` with `abandoned`, and the holds **released**
 * `cancelled` — nothing timed out, and F-092-k's audit of its own work must
 * stay able to tell an abandoned top-up from a lapsed one.
 *
 * **Only a payment the platform cannot already have charged.** Three things
 * narrow it, and each is the whole reason this route is safe:
 *
 * - **the payer's own** — the user is the gate's, in the read and not only in
 *   the guard, so a payment id typed into a body closes nobody else's;
 * - **an in-chat gateway only** — a `return` or `webhook` payment's browser may
 *   be at the bank this second, and ADR-0047 decision 2 keeps those holds until
 *   the clock plus `COUPON_HOLD_AFTER_EXPIRY_SEC` for exactly that reason. The
 *   sheet is the only close a client can actually witness;
 * - **never approved** — `gatewayTrackingCode` and `nextVerifyAt` both null. A
 *   pre-checkout that answered yes is the moment the platform may take the
 *   money (`DepositInChatService`), and from there the verify ladder owns the
 *   row and its holds until it settles or a person closes it (F-092-x, F-092-y).
 *
 * The flip is status-guarded like every other close here: a `paid` relay
 * crediting the row between the read and the write finds it `pending`, this
 * one finds nothing to update, and a confirmed coupon use is never given back.
 */

/**
 * `status`, never `ok`: the response interceptor takes an object with an `ok`
 * key for an envelope of its own. Every outcome is a 200 — the page is only
 * tidying up after a sheet the payer closed, and a refusal is an ordinary
 * answer it does nothing with.
 */
export type AbandonResult = {
  status:
    | /** Closed here, holds given back. */ 'closed'
    | /** Not `pending` any more — already settled, closed or expired. */ 'already_closed'
    | /** Approved at pre-checkout: the platform may hold the money. */ 'not_abandonable'
    | /** No such payment of this user, or not one paid in a chat. */ 'not_found';
};

@Injectable()
export class DepositAbandonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: PaymentProviderRegistry,
    private readonly reservations: CouponReservationService,
  ) {}

  async abandon(request: { userId: string; paymentId: string }): Promise<AbandonResult> {
    return tenantTransaction(this.prisma, async (tx) => {
      const payment = await tx.paymentTransaction.findFirst({
        where: { id: request.paymentId, userId: request.userId },
        select: PAYMENT_SELECT,
      });
      if (!payment) return { status: 'not_found' };

      const { providerName } = gatewayRefOf(payment);
      // A driver this build does not have is not an in-chat one as far as
      // anything here can tell, and reconciliation owns that row either way.
      if (!this.providers.has(providerName) || this.providers.get(providerName).settlement !== 'in_chat') {
        return { status: 'not_found' };
      }
      if (payment.status !== PaymentStatus.pending) return { status: 'already_closed' };
      if (payment.gatewayTrackingCode !== null || payment.nextVerifyAt !== null) return { status: 'not_abandonable' };

      const { count } = await tx.paymentTransaction.updateMany({
        where: { id: payment.id, status: PaymentStatus.pending, gatewayTrackingCode: null, nextVerifyAt: null },
        // `expiresAt` is cleared, as `close()` does: this payment is over, and
        // the expiry sweep has nothing left to find.
        data: { status: PaymentStatus.failed, failureCode: 'abandoned', expiresAt: null, nextVerifyAt: null },
      });
      if (count !== 1) return { status: 'already_closed' };

      await this.reservations.release(tx, payment.id, RedemptionStatus.cancelled);
      return { status: 'closed' };
    });
  }
}
