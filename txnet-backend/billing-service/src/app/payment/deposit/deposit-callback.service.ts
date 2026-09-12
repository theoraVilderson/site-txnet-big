import { Injectable, Logger } from '@nestjs/common';
import { ConfirmationSource, PaymentStatus, Prisma, RedemptionStatus, WalletReasonType } from '@prisma/client';
import { CredentialUnavailable, TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { WalletLedgerService } from '../../wallet/wallet-ledger.service';
import { CouponReservationService } from '../coupon/coupon-reservation';
import { GatewayMerchant, GatewaySource, MerchantGatewayRef } from '../gateway/gateway-merchant';
import { GatewayFailure, GatewayFailureReason } from '../gateway/payment-provider';
import { PaymentProviderRegistry } from '../gateway/payment-provider.registry';

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
  /** The gateway did not answer, or answered something that settles nothing. The row is untouched. */
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
  | { kind: 'failed'; code: CallbackFailureCode };

export type CallbackRequest = {
  /** `payment_transaction.gatewayTrackingCode` — Zarinpal's `Authority` (ADR-0028). */
  authority: string;
  /** The gateway's own verdict on the query string — Zarinpal's `Status`. `OK` means "ask me". */
  gatewayStatus: string | null;
};

/**
 * Reasons whose answer is "we do not know", and which therefore must not close
 * the payment. Everything else the gateway says is a refusal we can act on.
 */
const UNSETTLED: readonly GatewayFailureReason[] = ['unavailable', 'amount_mismatch'];

/** What the row is selected as. No secret column is ever on this list (invariant 8). */
const PAYMENT_SELECT = {
  id: true,
  userId: true,
  status: true,
  gatewayId: true,
  tenantGatewayConfigId: true,
  amountCredited: true,
  chargedAmountMinor: true,
  gatewayReferenceId: true,
  gateway: { select: { providerName: true } },
  tenantGatewayConfig: { select: { providerName: true } },
} satisfies Prisma.PaymentTransactionSelect;

type PaymentRow = Prisma.PaymentTransactionGetPayload<{ select: typeof PAYMENT_SELECT }>;

@Injectable()
export class DepositCallbackService {
  private readonly logger = new Logger(DepositCallbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: CouponReservationService,
    private readonly providers: PaymentProviderRegistry,
    private readonly merchant: GatewayMerchant,
    private readonly ledger: WalletLedgerService,
  ) {}

  async settle(request: CallbackRequest): Promise<CallbackOutcome> {
    const tenant = TenantContext.current('deposit callback');
    const { authority } = request;
    if (!authority) return { kind: 'failed', code: 'INVALID_PARAMS' };

    try {
      // 1. Read. The client is tenant-scoped, so an authority belonging to
      //    another reseller is simply not found — the host resolved this tenant
      //    (ADR-0025) and nothing on the query string can widen it.
      const payment = await tenantTransaction(this.prisma, (tx) =>
        tx.paymentTransaction.findFirst({
          where: { gatewayTrackingCode: authority },
          select: PAYMENT_SELECT,
        }),
      );
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
      if (payment.status !== PaymentStatus.pending) {
        // `failed` or `expired`: F-092-k closed it, or an earlier callback did.
        // Reopening it here would be this service deciding against the job that
        // owns the clock.
        return { kind: 'failed', code: 'VERIFICATION_FAILED' };
      }

      // 3. The gateway's own verdict, before we spend a vault read on it. A
      //    payer who pressed cancel is a settled answer — the bank is not going
      //    to say anything else — so the holds go back now rather than at the
      //    expiry job's convenience.
      if (request.gatewayStatus && request.gatewayStatus.toUpperCase() !== 'OK') {
        await this.close(payment, 'payment_failed');
        return { kind: 'failed', code: 'VERIFICATION_FAILED' };
      }

      return await this.verifyAndCredit(payment, authority);
    } catch (e) {
      // The row is untouched by definition: everything that writes is inside a
      // transaction below this, and a throw rolled it back.
      this.logger.error(`deposit callback failed for authority ${authority}`, e instanceof Error ? e.stack : String(e));
      return { kind: 'failed', code: 'SYSTEM_ERROR' };
    }
  }

  /** Ask the gateway — outside every transaction — and act on what it says. */
  private async verifyAndCredit(payment: PaymentRow, authority: string): Promise<CallbackOutcome> {
    const ref = this.gatewayRef(payment);
    const provider = this.providers.get(ref.providerName);

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
      });
    } catch (e) {
      return await this.refused(payment, e);
    }

    // 4. The money. The flip, the credit, the coupon uses and the event, in one
    //    transaction — and the flip first, because its `count` is the guard the
    //    other three hang off.
    return await tenantTransaction(this.prisma, async (tx) => {
      const { count } = await tx.paymentTransaction.updateMany({
        where: { id: payment.id, status: PaymentStatus.pending },
        data: {
          status: PaymentStatus.success,
          gatewayReferenceId: verified.referenceId,
          cardPanMasked: verified.cardPan,
          // The enum names webhook, reconciliation and admin; a browser
          // returning from the bank is the first of those — the gateway's own
          // confirmation, taken automatically.
          confirmationSource: ConfirmationSource.webhook_auto,
          // A payment that has landed has no clock left to run out (F-092-k).
          expiresAt: null,
        },
      });
      if (count !== 1) {
        // Another callback flipped it between our read and this write. It did
        // the crediting; this one must not, and must not report a failure
        // either — the user paid, and the payment is settled.
        return { kind: 'success', paymentId: payment.id, referenceId: verified.referenceId, alreadyPaid: true };
      }

      await this.ledger.credit(tx, {
        userId: payment.userId,
        // `amountCredited`, which already carries the adjustment gap the quote
        // computed. `amountRequested` is what the user typed.
        amount: payment.amountCredited,
        reasonType: WalletReasonType.payment_gateway,
        referenceId: payment.id,
      });
      await this.reservations.confirm(tx, payment.id);
      await this.publishConfirmed(tx, payment, verified.referenceId);

      return { kind: 'success', paymentId: payment.id, referenceId: verified.referenceId, alreadyPaid: false };
    });
  }

  /**
   * The gateway would not verify. Two different things wear that shape, and
   * telling them apart is the whole of this method: a refusal closes the
   * payment and gives the coupon capacity back, while silence changes nothing
   * at all and waits for F-092-l.
   */
  private async refused(payment: PaymentRow, cause: unknown): Promise<CallbackOutcome> {
    const unsettled =
      cause instanceof CredentialUnavailable ||
      !(cause instanceof GatewayFailure) ||
      UNSETTLED.includes(cause.reason);

    if (unsettled) {
      this.logger.warn(
        `payment ${payment.id} left pending: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`,
      );
      return { kind: 'failed', code: 'GATEWAY_CONNECTION_ERROR' };
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
        data: { status: PaymentStatus.failed, failureCode, expiresAt: null },
      });
      if (count !== 1) return;
      await this.reservations.release(tx, payment.id, RedemptionStatus.cancelled);
    });
  }

  /**
   * The cross-domain announcement, in the transaction that made it true
   * (ADR-0021).
   *
   * `payload` carries its own `tenantId` because the relay reads under no
   * scope and `outbox_event` has no tenant column of its own
   * (`prisma/domains/automation.prisma`) — the domain that writes an event
   * decides what it means, and this one means "this tenant's user was
   * credited".
   *
   * Money is a decimal **string**, the same rule every billing route answers
   * under (ADR-0019): JSON has no exact decimal, and a float here would be a
   * rounding error that arrives in a consumer nobody has written yet.
   */
  private async publishConfirmed(tx: Prisma.TransactionClient, payment: PaymentRow, referenceId: string): Promise<void> {
    const tenant = TenantContext.current('deposit callback event');
    const ref = this.gatewayRef(payment);
    await tx.outboxEvent.create({
      data: {
        aggregate: 'billing.payment',
        aggregateId: payment.id,
        type: 'billing.payment.confirmed',
        payload: {
          tenantId: tenant.id,
          userId: payment.userId,
          paymentId: payment.id,
          amountCredited: payment.amountCredited.toFixed(2),
          gateway: { source: ref.source, id: ref.gatewayId },
          gatewayReferenceId: referenceId,
          confirmationSource: ConfirmationSource.webhook_auto,
        },
      },
      select: { id: true },
    });
  }

  /**
   * Which gateway this payment names. Exactly one of the two columns is set — a
   * CHECK says so (ADR-0006, ADR-0028) — so the branch is total and a row with
   * neither is a schema violation rather than a case to handle.
   */
  private gatewayRef(payment: PaymentRow): MerchantGatewayRef {
    const tenant = TenantContext.current('deposit callback gateway');
    const platform = payment.gatewayId !== null;
    const source: GatewaySource = platform ? 'platform' : 'tenant';
    const gatewayId = platform ? payment.gatewayId : payment.tenantGatewayConfigId;
    const providerName = platform ? payment.gateway?.providerName : payment.tenantGatewayConfig?.providerName;
    if (!gatewayId || !providerName) {
      throw new Error(`payment ${payment.id} names no gateway; the CHECK in 20260911000000_payment_legacy_port should forbid it`);
    }
    return { tenantId: tenant.id, source, gatewayId, providerName };
  }
}
