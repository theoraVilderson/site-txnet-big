import { Injectable, Logger } from '@nestjs/common';
import { ConfirmationSource, PaymentStatus } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import type { PaymentProvider } from '../gateway/payment-provider';
import { PaymentProviderRegistry } from '../gateway/payment-provider.registry';
import { money } from './deposit-quote.service';
import { DepositSettlementService, gatewayRefOf, PAYMENT_SELECT, PaymentRow } from './deposit-settlement';
import { scheduleVerifyRetry } from './verify-retry';

/**
 * Settling a payment made inside a chat (F-104-k, D-32).
 *
 * `billing` never holds a bot token, so it never talks to the messenger: the
 * bot receives `pre_checkout_query` and `successful_payment` (F-104-l's neutral
 * events) and relays each here, through the gate, as the payer, with the
 * service token (`DepositInChatController`). The invoice's payload is the
 * payment id `start` answered.
 *
 * **Pre-checkout is the last moment to refuse.** It approves only this payer's
 * open payment at an in-chat gateway, for exactly the charge `start` wrote.
 * Approving writes the payment id as the row's authority and starts the verify
 * clock (F-092-x) in the same transaction: from then on the platform may take
 * the money, so the row must not be expired quietly (the sweep skips a
 * verifying row), and a `paid` that never arrives walks the retry ladder —
 * where the driver's `inquire` can only answer `unavailable` — to a person
 * (F-092-y). An in-chat driver has nothing to ask.
 *
 * **Paid is F-092-j's guarded credit**, `webhook_auto` (the platform's server
 * delivered it), the platform's charge id as the reference. What arrived is
 * reported as a receipt only when it differs from the charge (F-104-d); a
 * `paid` in another currency cannot be valued and settles nothing — the row
 * stays verifying for a person.
 */

export type InChatPaymentRef = {
  userId: string;
  /** The invoice payload. */
  paymentId: string;
  currency: string;
  /** In `currency`'s smallest unit, as the messenger reported it. */
  totalAmount: bigint;
};

export type PreCheckoutRefusal = 'not_found' | 'not_payable' | 'amount_mismatch';
export type PreCheckoutVerdict = { ok: true } | { ok: false; reason: PreCheckoutRefusal };

export type InChatPaidResult = {
  status: 'credited' | 'already_settled' | 'unsettled' | 'not_found';
  /** Base currency, what the wallet received — `null` unless the payment is settled. */
  credited: string | null;
};

const IN_CHAT_SELECT = { ...PAYMENT_SELECT, expiresAt: true } as const;
type InChatRow = PaymentRow & { expiresAt: Date | null };

@Injectable()
export class DepositInChatService {
  private readonly logger = new Logger(DepositInChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: PaymentProviderRegistry,
    private readonly settlement: DepositSettlementService,
  ) {}

  async preCheckout(ref: InChatPaymentRef, now = new Date()): Promise<PreCheckoutVerdict> {
    const found = await this.find(ref);
    if (!found) return { ok: false, reason: 'not_found' };
    const { payment, provider } = found;

    if (payment.status !== PaymentStatus.pending) return { ok: false, reason: 'not_payable' };
    const approved = payment.gatewayTrackingCode === payment.id;
    // Past its clock and never approved: the sweep may close it any moment.
    if (!approved && (!payment.expiresAt || payment.expiresAt <= now)) return { ok: false, reason: 'not_payable' };
    if (ref.currency !== provider.chargeCurrency || ref.totalAmount !== payment.chargedAmountMinor) {
      return { ok: false, reason: 'amount_mismatch' };
    }

    const ok = await tenantTransaction(this.prisma, async (tx) => {
      const { count } = await tx.paymentTransaction.updateMany({
        where: {
          id: payment.id,
          status: PaymentStatus.pending,
          OR: [{ gatewayTrackingCode: null }, { gatewayTrackingCode: payment.id }],
        },
        data: { gatewayTrackingCode: payment.id },
      });
      if (count !== 1) return false;
      // A repeated query for an approved payment is already on the clock.
      if (payment.nextVerifyAt === null) await scheduleVerifyRetry(tx, payment, now);
      return true;
    });
    return ok ? { ok: true } : { ok: false, reason: 'not_payable' };
  }

  async paid(ref: InChatPaymentRef & { chargeId: string }): Promise<InChatPaidResult> {
    const found = await this.find(ref);
    if (!found) {
      // The platform took money for a payment this payer does not have here.
      this.logger.error(`in-chat paid for unknown payment ${ref.paymentId} (charge ${ref.chargeId})`);
      return { status: 'not_found', credited: null };
    }
    const { payment, provider } = found;

    if (ref.currency !== provider.chargeCurrency) {
      this.logger.error(`payment ${payment.id} paid in ${ref.currency}, charged in ${provider.chargeCurrency}: not settled`);
      return { status: 'unsettled', credited: null };
    }
    const received =
      ref.totalAmount === payment.chargedAmountMinor
        ? undefined
        : { amountMinor: ref.totalAmount, currency: ref.currency, decimals: provider.chargeDecimals };

    const credited = await this.settlement.creditVerified(
      payment,
      { referenceId: ref.chargeId, cardPan: null, ...(received ? { received } : {}) },
      ConfirmationSource.webhook_auto,
    );
    const after = await this.read(ref);
    const settled = after?.status === PaymentStatus.success;
    return {
      status: credited ? 'credited' : settled ? 'already_settled' : 'unsettled',
      credited: settled && after ? money(after.amountCredited) : null,
    };
  }

  /** This payer's payment, at a gateway that settles in chat — or `null`, never a hint which. */
  private async find(ref: InChatPaymentRef): Promise<{ payment: InChatRow; provider: PaymentProvider } | null> {
    const payment = await this.read(ref);
    if (!payment) return null;
    const { providerName } = gatewayRefOf(payment);
    if (!this.providers.has(providerName)) return null;
    const provider = this.providers.get(providerName);
    return provider.settlement === 'in_chat' ? { payment, provider } : null;
  }

  private read(ref: InChatPaymentRef): Promise<InChatRow | null> {
    return tenantTransaction(this.prisma, (tx) =>
      tx.paymentTransaction.findFirst({ where: { id: ref.paymentId, userId: ref.userId }, select: IN_CHAT_SELECT }),
    );
  }
}
