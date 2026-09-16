import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfirmationSource, PaymentStatus, RedemptionStatus } from '@prisma/client';
import { CredentialUnavailable, TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { CouponReservationService } from '../coupon/coupon-reservation';
import { GatewayMerchant } from '../gateway/gateway-merchant';
import { GatewayFailure, GatewayFailureReason } from '../gateway/payment-provider';
import { PaymentProviderRegistry } from '../gateway/payment-provider.registry';
import { PAYMENT_SELECT, PaymentRow, DepositSettlementService, gatewayRefOf } from './deposit-settlement';
import { offerAuthority } from './payment-callback-url';
import { scheduleVerifyRetry } from './verify-retry';

/**
 * Settling a top-up (F-092-j) — the half of a payment the bank starts.
 *
 * `DepositStartService` ends by sending a browser to a gateway. This is where
 * that browser comes back, and the order is the one ADR-0028 named: **ask the
 * gateway outside every transaction, then flip the row guarded by its own
 * status, and credit inside that same transaction.**
 *
 * Both halves of that matter for a different reason.
 *
 * *Outside*, because a `verify` is a call to a bank and a transaction held open
 * across one is a connection nobody else can have. Legacy got this right and it
 * is the one thing kept from `payment/verify/route.ts` unchanged.
 *
 * *Guarded*, because this route is called more than once by design. A bank
 * redirects a browser that the user may reload; a webhook is retried until it
 * is answered; reconciliation (F-092-l) re-reads the same payment later. So the
 * flip is `updateMany({ where: { id, status: pending } })` and the credit hangs
 * off its `count`, rather than off a status this code read a moment earlier:
 * two callbacks racing both see `pending`, and Postgres re-checks that `where`
 * after the loser waits on the winner's row lock. Legacy's
 * `findOneAndUpdate({ status: { $ne: SUCCESS } })` was the same idea; what it
 * lacked was the unique index behind it (invariant 7, ADR-0028), so a duplicate
 * with a *different* row and the same authority was still possible.
 *
 * **An unknown outcome is not a failure.** A gateway that times out has not
 * said no — it has said nothing, and the money may well have moved. Marking the
 * row `failed` would release the coupon holds and, worse, put the payment in a
 * state reconciliation has no reason to revisit. So `unavailable` and
 * `amount_mismatch` leave the row exactly as it was, `pending`, for F-092-l to
 * resolve against the gateway's own records (invariant 9: never auto-reverse,
 * and never auto-close either).
 *
 * **The event commits with the money** (ADR-0021). The `outbox_event` row is
 * written inside the crediting transaction, not after it, so there is no window
 * where a wallet grew and nothing was announced. Nothing consumes it yet; the
 * relay marks it `unroutable` and that is visible rather than silent.
 */

/**
 * What the panel's result page is told. Legacy's five codes, kept verbatim
 * because F-093-f turns exactly these into i18n keys — a code renamed here is a
 * page that renders nothing.
 */
export type CallbackFailureCode =
  /** No authority on the query string: not a callback this gateway sent. */
  | 'INVALID_PARAMS'
  /** No payment of this tenant carries that authority. */
  | 'TRANSACTION_NOT_FOUND'
  /**
   * The gateway did not answer. Since F-093-l nothing sends it: that case is
   * the `verifying` outcome. Kept so a token signed before the change still
   * reads, and because the panel's key list is checked against this union.
   */
  | 'GATEWAY_CONNECTION_ERROR'
  /** The gateway answered, and the answer was no. */
  | 'VERIFICATION_FAILED'
  /** Something here broke. The row is untouched. */
  | 'SYSTEM_ERROR';

export type CallbackOutcome =
  | {
      kind: 'success';
      paymentId: string;
      /** The gateway's receipt number, for the user to quote. */
      referenceId: string | null;
      /** This callback found the payment already settled — by a reload, a retry, or a race it lost. */
      alreadyPaid: boolean;
    }
  | { kind: 'failed'; code: CallbackFailureCode }
  /**
   * The gateway met the verify with silence: still `pending`, now verifying
   * (F-092-x). The panel's pending page polls it (F-093-l, ADR-0044 decision 7).
   */
  | { kind: 'verifying'; paymentId: string };

/** The outcome, plus the panel origin the payment was started from when the row has one. */
export type SettledCallback = CallbackOutcome & { returnOrigin?: string };

export type CallbackRequest = {
  /** `payment_transaction.gatewayTrackingCode` — Zarinpal's `Authority` (ADR-0028). */
  authority: string;
  /** The gateway's own verdict on the query string — Zarinpal's `Status`. `OK` means "ask me". */
  gatewayStatus: string | null;
  /**
   * The payment id the callback URL was minted with (`?p=`, F-092-ad), already
   * checked to be a UUID. Consulted only when no row carries the authority.
   */
  paymentId?: string | null;
};

/**
 * Reasons whose answer is "we do not know", and which therefore must not close
 * the payment. Everything else the gateway says is a refusal we can act on.
 */
const UNSETTLED: readonly GatewayFailureReason[] = ['unavailable', 'amount_mismatch'];

@Injectable()
export class DepositCallbackService {
  private readonly logger = new Logger(DepositCallbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: CouponReservationService,
    private readonly providers: PaymentProviderRegistry,
    private readonly merchant: GatewayMerchant,
    private readonly settlement: DepositSettlementService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  async settle(request: CallbackRequest): Promise<SettledCallback> {
    let returnOrigin: string | null = null;
    const outcome = await this.outcomeOf(request, (origin) => (returnOrigin = origin));
    return returnOrigin ? { ...outcome, returnOrigin } : outcome;
  }

  private async outcomeOf(
    request: CallbackRequest,
    foundOrigin: (origin: string | null) => void,
  ): Promise<CallbackOutcome> {
    const tenant = TenantContext.current('deposit callback');
    const { authority } = request;
    if (!authority) return { kind: 'failed', code: 'INVALID_PARAMS' };

    try {
      // 1. Read. The client is tenant-scoped, so an authority belonging to
      //    another reseller is simply not found — the host resolved this tenant
      //    (ADR-0025) and nothing on the query string can widen it.
      let payment = await tenantTransaction(this.prisma, (tx) =>
        tx.paymentTransaction.findFirst({
          where: { gatewayTrackingCode: authority },
          select: { ...PAYMENT_SELECT, returnOrigin: true },
        }),
      );
      // No row carries it: perhaps the write of this authority was lost after
      // the gateway minted it (F-092-ad, ADR-0046 decision 4). The id the
      // callback URL names finds that payment — only one still without an
      // authority, and still open.
      const recovered = !payment && !!request.paymentId;
      if (recovered) {
        payment = await tenantTransaction(this.prisma, (tx) =>
          tx.paymentTransaction.findFirst({
            where: {
              id: request.paymentId as string,
              gatewayTrackingCode: null,
              status: { in: [PaymentStatus.pending, PaymentStatus.expired] },
            },
            select: { ...PAYMENT_SELECT, returnOrigin: true },
          }),
        );
      }
      foundOrigin(payment?.returnOrigin ?? null);
      if (!payment) {
        // Not logged as an error: an authority nobody minted is what a stray
        // bookmark or a probe looks like, and it is the same answer either way.
        this.logger.debug(`callback for an authority no payment of tenant ${tenant.id} carries`);
        return { kind: 'failed', code: 'TRANSACTION_NOT_FOUND' };
      }

      // 2. Already settled. A reload of the result page is the common case, and
      //    it must cost nothing: no vault read, no call to the bank.
      if (payment.status === PaymentStatus.success) {
        return {
          kind: 'success',
          paymentId: payment.id,
          referenceId: payment.gatewayReferenceId,
          alreadyPaid: true,
        };
      }
      if (payment.status === PaymentStatus.failed) {
        // A stated refusal, by an earlier callback or the gateway. Final.
        return { kind: 'failed', code: 'VERIFICATION_FAILED' };
      }
      // `pending`, or `expired`: the clock ran out before the payer came back —
      // our own outage outlasting it is the usual reason — and the bank may
      // have the money all the same. It is verified like a pending one, and the
      // settlement claims back the holds the clock released (ADR-0046 decision 1).

      // A gateway that settles by webhook is settled by its signed post, never
      // by a browser (ADR-0051 decision 5): this return only shows the payer
      // where it stands. A recovered payment's authority is only a URL's word,
      // so it is not even asked about.
      if (this.providers.get(gatewayRefOf(payment).providerName).settlement === 'webhook') {
        return recovered ? { kind: 'verifying', paymentId: payment.id } : await this.showOnly(payment, authority);
      }

      // 3. The gateway's own verdict, before we spend a vault read on it. A
      //    payer who pressed cancel is a settled answer — the bank is not going
      //    to say anything else — so the holds go back now rather than at the
      //    expiry job's convenience.
      if (request.gatewayStatus && request.gatewayStatus.toUpperCase() !== 'OK') {
        // A recovered payment is not closed on the query string's word: anyone
        // can type an id and `NOK` into a URL.
        if (!recovered) await this.close(payment, 'payment_failed');
        return { kind: 'failed', code: 'VERIFICATION_FAILED' };
      }

      return await this.verifyAndCredit(payment, authority, recovered);
    } catch (e) {
      // The row is untouched by definition: everything that writes is inside a
      // transaction below this, and a throw rolled it back.
      this.logger.error(`deposit callback failed for authority ${authority}`, e instanceof Error ? e.stack : String(e));
      return { kind: 'failed', code: 'SYSTEM_ERROR' };
    }
  }

  /** Ask the gateway — outside every transaction — and act on what it says. */
  private async verifyAndCredit(payment: PaymentRow, authority: string, recovered: boolean): Promise<CallbackOutcome> {
    const ref = gatewayRefOf(payment);
    const provider = this.providers.get(ref.providerName);

    // A payer's browser is waiting on this answer. Past the budget the gateway
    // is silent as far as the payer is concerned: the pending page and the
    // retry ladder take over (F-092-ab, ADR-0046 decision 2). Started before the
    // vault read, which is part of what the payer waits for.
    const deadlineAt = Date.now() + this.config.get('DEPOSIT_CALLBACK_VERIFY_BUDGET_MS', { infer: true });

    let verified: { referenceId: string; cardPan: string | null };
    try {
      const credentials = await this.merchant.credentialsFor(ref, payment.userId);
      verified = await provider.verify({
        credentials,
        authority,
        // The amount the row was charged at, never recomputed here: re-pricing
        // at settlement time is how a rate that moved becomes a mismatch
        // (ADR-0019, invariant 12).
        amountMinor: payment.chargedAmountMinor,
        deadlineAt,
      });
    } catch (e) {
      return await this.refused(payment, e, recovered ? authority : null);
    }

    // 4. The money — the flip, the credit, the coupon uses and the event, in
    //    one transaction, and none of it spelled here: `DepositSettlementService`
    //    is that transaction, shared with reconciliation (F-092-l) so the two
    //    ways of learning a payment landed cannot drift into two ways of
    //    crediting it.
    const credited = await this.settlement.creditVerified(
      payment,
      {
        referenceId: verified.referenceId,
        cardPan: verified.cardPan,
        // Written in the crediting flip, guarded `gatewayTrackingCode: null`.
        ...(recovered ? { authority } : {}),
      },
      // A browser returning from the bank is the gateway's own confirmation,
      // taken automatically — the first of the enum's three.
      ConfirmationSource.webhook_auto,
    );
    return {
      kind: 'success',
      paymentId: payment.id,
      referenceId: verified.referenceId,
      // Not credited here means another caller flipped the row between our read
      // and the write. It did the crediting; this one must not report a failure
      // either — the user paid, and the payment is settled.
      alreadyPaid: !credited,
    };
  }

  /**
   * A webhook gateway's browser return (F-104-b): `inquire`, and show success
   * when the money is there, pending otherwise. Writes nothing — no credit, no
   * close, no retry clock; the webhook and F-092-l's sweep own those.
   */
  private async showOnly(payment: PaymentRow, authority: string): Promise<CallbackOutcome> {
    const ref = gatewayRefOf(payment);
    try {
      const credentials = await this.merchant.credentialsFor(ref, payment.userId);
      const { status } = await this.providers.get(ref.providerName).inquire({ credentials, authority });
      if (status === 'verified') return { kind: 'success', paymentId: payment.id, referenceId: null, alreadyPaid: false };
    } catch (e) {
      this.logger.warn(`payment ${payment.id}: inquire on return failed, shown as pending: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { kind: 'verifying', paymentId: payment.id };
  }

  /**
   * The gateway would not verify. Two different things wear that shape, and
   * telling them apart is the whole of this method: a refusal closes the
   * payment and gives the coupon capacity back, while silence changes nothing
   * at all and waits for F-092-l.
   */
  private async refused(
    payment: PaymentRow,
    cause: unknown,
    /** The authority a recovered payment was found for (F-092-ad), or `null`. */
    recoveredAuthority: string | null = null,
  ): Promise<CallbackOutcome> {
    const unsettled =
      cause instanceof CredentialUnavailable ||
      !(cause instanceof GatewayFailure) ||
      UNSETTLED.includes(cause.reason);

    if (recoveredAuthority !== null && !unsettled) {
      // The gateway refused the authority this URL brought. Nothing is written:
      // the payment's real authority may still arrive, and an id typed into a
      // URL must not be able to close somebody else's payment.
      return { kind: 'failed', code: 'TRANSACTION_NOT_FOUND' };
    }

    if (unsettled) {
      // Still `pending`, but now verifying: the retry clock says when to ask
      // again (F-092-x, ADR-0044 decision 2), rather than waiting for the
      // expiry clock and the reconciliation window. A recovered payment is
      // **offered** the authority it was found for, not given it (F-092-ag,
      // ADR-0047 decision 1): silence proves nothing about an authority anyone
      // with the payment id could have typed, so it waits beside the row until
      // the gateway confirms it, and cannot hold the place of the real one.
      const retryAt = await tenantTransaction(this.prisma, async (tx) => {
        if (recoveredAuthority !== null) await offerAuthority(tx, payment, recoveredAuthority);
        return scheduleVerifyRetry(tx, payment, new Date());
      });
      this.logger.warn(
        `payment ${payment.id} left pending, verifying again at ${retryAt?.toISOString() ?? '(already moved)'}: ` +
          `${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`,
      );
      // Not "failed": the money may have moved, and a payer told otherwise pays
      // again. The pending page polls the row and shows whatever it becomes.
      return { kind: 'verifying', paymentId: payment.id };
    }

    await this.close(payment, (cause as GatewayFailure).reason);
    return { kind: 'failed', code: 'VERIFICATION_FAILED' };
  }

  /**
   * The payment is over: `failed` with the gateway's reason, and the holds are
   * **released** `cancelled` — nothing timed out, so `expired` would lie to
   * F-092-k's audit of its own work.
   *
   * Status-guarded like the credit, for the same reason: a refusal racing a
   * success must not overwrite it.
   */
  private async close(payment: PaymentRow, failureCode: string): Promise<void> {
    await tenantTransaction(this.prisma, async (tx) => {
      const { count } = await tx.paymentTransaction.updateMany({
        where: { id: payment.id, status: PaymentStatus.pending },
        data: { status: PaymentStatus.failed, failureCode, expiresAt: null, nextVerifyAt: null },
      });
      if (count !== 1) return;
      await this.reservations.release(tx, payment.id, RedemptionStatus.cancelled);
    });
  }
}
