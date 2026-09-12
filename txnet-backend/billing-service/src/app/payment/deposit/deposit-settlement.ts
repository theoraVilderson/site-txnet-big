import { Injectable } from '@nestjs/common';
import { ConfirmationSource, PaymentStatus, Prisma, WalletReasonType } from '@prisma/client';
import { TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { WalletLedgerService } from '../../wallet/wallet-ledger.service';
import { CouponReservationService } from '../coupon/coupon-reservation';
import { GatewaySource, MerchantGatewayRef } from '../gateway/gateway-merchant';

/**
 * The moment a top-up becomes money, and the only place it happens (F-092-j,
 * F-092-l).
 *
 * There are two ways to learn that a gateway took a payment — the payer comes
 * back and the callback asks (`deposit-callback.service.ts`), or nobody came
 * back and reconciliation asks later (`deposit-reconciliation.service.ts`) —
 * and exactly one way to act on it. This is that one way, extracted when the
 * second caller arrived rather than spelled twice: the flip, the credit, the
 * coupon confirm and the outbox event, in one transaction, guarded by the row's
 * own status.
 *
 * **The flip is the guard.** `updateMany({ where: { id, status: pending } })`,
 * with everything else hanging off its `count` — never off a status read a
 * moment earlier. A bank redirecting twice, a retried webhook and a
 * reconciliation run racing the payer all see `pending`, and Postgres re-checks
 * that `where` after the loser waits on the winner's row lock, so the wallet
 * grows once (ADR-0028, invariant 7).
 *
 * **The event commits with the money** (ADR-0021): written inside the same
 * transaction, so there is no window where a wallet grew and nothing was
 * announced.
 *
 * What differs between the two callers is one enum — `webhook_auto` when a
 * payer's browser brought the answer, `reconciliation_auto` when a sweep went
 * and asked — and that is the only thing this takes from them.
 */

/** What the row is selected as. No secret column is ever on this list (invariant 8). */
export const PAYMENT_SELECT = {
  id: true,
  userId: true,
  status: true,
  gatewayId: true,
  tenantGatewayConfigId: true,
  amountCredited: true,
  chargedAmountMinor: true,
  // The authority. The callback arrives holding one; reconciliation has to read
  // it off the row, because nothing brought it (F-092-l).
  gatewayTrackingCode: true,
  gatewayReferenceId: true,
  gateway: { select: { providerName: true } },
  tenantGatewayConfig: { select: { providerName: true } },
} satisfies Prisma.PaymentTransactionSelect;

export type PaymentRow = Prisma.PaymentTransactionGetPayload<{ select: typeof PAYMENT_SELECT }>;

/** What a gateway's `verify` answered, and which of the two askers is holding it. */
export type VerifiedPayment = {
  referenceId: string;
  cardPan: string | null;
};

@Injectable()
export class DepositSettlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: CouponReservationService,
    private readonly ledger: WalletLedgerService,
  ) {}

  /**
   * Credit a verified payment, once.
   *
   * Answers whether **this** call was the one that did it. `false` is not a
   * failure: it means another caller won the guard and the payment is settled,
   * which is the ordinary outcome of a reload, a retried webhook, or a sweep
   * arriving a second after the payer.
   */
  async creditVerified(
    payment: PaymentRow,
    verified: VerifiedPayment,
    source: ConfirmationSource,
  ): Promise<boolean> {
    return tenantTransaction(this.prisma, async (tx) => {
      const { count } = await tx.paymentTransaction.updateMany({
        where: { id: payment.id, status: PaymentStatus.pending },
        data: {
          status: PaymentStatus.success,
          gatewayReferenceId: verified.referenceId,
          cardPanMasked: verified.cardPan,
          confirmationSource: source,
          // A payment that has landed has no clock left to run out (F-092-k).
          expiresAt: null,
        },
      });
      if (count !== 1) return false;

      await this.ledger.credit(tx, {
        userId: payment.userId,
        // `amountCredited`, which already carries the adjustment gap the quote
        // computed. `amountRequested` is what the user typed.
        amount: payment.amountCredited,
        reasonType: WalletReasonType.payment_gateway,
        referenceId: payment.id,
      });
      await this.reservations.confirm(tx, payment.id);
      await this.publishConfirmed(tx, payment, verified.referenceId, source);
      return true;
    });
  }

  /**
   * The cross-domain announcement, in the transaction that made it true
   * (ADR-0021).
   *
   * `payload` carries its own `tenantId` because the relay reads under no scope
   * and `outbox_event` has no tenant column of its own
   * (`prisma/domains/automation.prisma`) — the domain that writes an event
   * decides what it means, and this one means "this tenant's user was
   * credited".
   *
   * Money is a decimal **string**, the same rule every billing route answers
   * under (ADR-0019): JSON has no exact decimal, and a float here would be a
   * rounding error arriving in a consumer nobody has written yet.
   */
  private async publishConfirmed(
    tx: Prisma.TransactionClient,
    payment: PaymentRow,
    referenceId: string,
    source: ConfirmationSource,
  ): Promise<void> {
    const tenant = TenantContext.current('deposit settlement event');
    const ref = gatewayRefOf(payment);
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
          confirmationSource: source,
        },
      },
      select: { id: true },
    });
  }
}

/**
 * Which gateway a payment names. Exactly one of the two columns is set — a
 * CHECK says so (ADR-0006, ADR-0028) — so the branch is total and a row with
 * neither is a schema violation rather than a case to handle.
 *
 * A function rather than a method: both settlement and the two askers need it,
 * and the vault read that follows it happens outside every transaction.
 */
export function gatewayRefOf(payment: PaymentRow): MerchantGatewayRef {
  const tenant = TenantContext.current('deposit gateway');
  const platform = payment.gatewayId !== null;
  const source: GatewaySource = platform ? 'platform' : 'tenant';
  const gatewayId = platform ? payment.gatewayId : payment.tenantGatewayConfigId;
  const providerName = platform ? payment.gateway?.providerName : payment.tenantGatewayConfig?.providerName;
  if (!gatewayId || !providerName) {
    throw new Error(
      `payment ${payment.id} names no gateway; the CHECK in 20260911000000_payment_legacy_port should forbid it`,
    );
  }
  return { tenantId: tenant.id, source, gatewayId, providerName };
}
