import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfirmationSource, PaymentStatus } from '@prisma/client';
import {
  parseTenantStatusState,
  runWithTenant,
  TENANT_STATUS_STORE,
  tenantAllows,
  TenantStatusStore,
  tenantTransaction,
  UnscopedRedisKeys,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
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
 * events) and relays each here with the service token and the sender's
 * messenger id (`DepositInChatController`). The invoice's payload is the
 * payment id `start` answered.
 *
 * **The event is the payment's, not the chat's (F-104-ab).** The relay carries
 * no user and no tenant — the chat that pays need not hold a session, and a
 * Mini App payer usually does not. The payment names both: it is found outside
 * every tenant, then admitted only when the sender is the payer `start`
 * recorded, on the gateway's messenger, through the payment tenant's own bot
 * (the one whose invoice it is). Anything else is `not_found` at pre-checkout;
 * at `paid` the platform already took the money, so it is `unsettled` and the
 * row stays verifying for a person (F-092-y). The rest runs in that tenant.
 *
 * **Pre-checkout is the last moment to refuse.** It approves only the payer's
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

/** Who relayed the event, as the bot saw it. Believed only beside the service token. */
export type InChatSender = {
  platform: string;
  /** The messenger id of whoever the platform says is paying. */
  senderId: string;
  /** The tenant of the bot the event arrived at. */
  botTenantId: string;
};

export type InChatPaymentRef = {
  sender: InChatSender;
  /** The invoice payload. */
  paymentId: string;
  currency: string;
  /** In `currency`'s smallest unit, as the messenger reported it. */
  totalAmount: bigint;
};

export type PreCheckoutRefusal = 'not_found' | 'not_payable' | 'amount_mismatch';
/**
 * `approved`, never `ok`: the response interceptor passes any object with an
 * `ok` key through as an envelope of its own, and the bot would read a refusal
 * as billing being unreachable.
 */
export type PreCheckoutVerdict = { approved: true } | { approved: false; reason: PreCheckoutRefusal };

export type InChatPaidResult = {
  status: 'credited' | 'already_settled' | 'unsettled' | 'not_found';
  /** What the wallet received — `null` unless the payment is settled. */
  credited: string | null;
  /** The payment's currency, what `credited` is in (F-116-h4); `null` beside a `null` credit. */
  currencyCode: string | null;
};

const IN_CHAT_SELECT = { ...PAYMENT_SELECT, expiresAt: true } as const;
type InChatRow = PaymentRow & { expiresAt: Date | null };

@Injectable()
export class DepositInChatService {
  private readonly logger = new Logger(DepositInChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly providers: PaymentProviderRegistry,
    private readonly settlement: DepositSettlementService,
    @Inject(TENANT_STATUS_STORE) private readonly tenantStatus: TenantStatusStore,
  ) {}

  async preCheckout(ref: InChatPaymentRef, now = new Date()): Promise<PreCheckoutVerdict> {
    const tenantId = await this.tenantOf(ref);
    if (!tenantId) return { approved: false, reason: 'not_found' };
    // D-42 (1): a closed tenant's users buy nothing. `TenantStatusGuard` cannot
    // say so here — the relay carries no tenant — so the payment's is asked.
    if (!(await this.takesDeposits(tenantId, now))) return { approved: false, reason: 'not_payable' };
    return runWithTenant({ id: tenantId }, () => this.approve(ref, now));
  }

  private async approve(ref: InChatPaymentRef, now: Date): Promise<PreCheckoutVerdict> {
    const found = await this.find(ref);
    if (!found) return { approved: false, reason: 'not_found' };
    const { payment, provider } = found;

    if (payment.status !== PaymentStatus.pending) return { approved: false, reason: 'not_payable' };
    const approved = payment.gatewayTrackingCode === payment.id;
    // Past its clock and never approved: the sweep may close it any moment.
    if (!approved && (!payment.expiresAt || payment.expiresAt <= now)) return { approved: false, reason: 'not_payable' };
    if (ref.currency !== provider.chargeCurrency || ref.totalAmount !== payment.chargedAmountMinor) {
      return { approved: false, reason: 'amount_mismatch' };
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
    return ok ? { approved: true } : { approved: false, reason: 'not_payable' };
  }

  async paid(ref: InChatPaymentRef & { chargeId: string }): Promise<InChatPaidResult> {
    const tenantId = await this.tenantOf(ref);
    if (tenantId === undefined) {
      // The platform took money for a payment nobody here has.
      this.logger.error(`in-chat paid for unknown payment ${ref.paymentId} (charge ${ref.chargeId})`);
      return { status: 'not_found', credited: null, currencyCode: null };
    }
    if (tenantId === null) {
      // Pre-checkout would have refused this sender. Money taken, nothing credited:
      // an approved row is already on the verify clock, and a person sees it.
      this.logger.error(
        `in-chat paid for payment ${ref.paymentId} (charge ${ref.chargeId}) from ${ref.sender.platform}:${ref.sender.senderId} ` +
          `via tenant ${ref.sender.botTenantId}'s bot, not its payer's: not settled`,
      );
      return { status: 'unsettled', credited: null, currencyCode: null };
    }
    return runWithTenant({ id: tenantId }, () => this.settle(ref));
  }

  private async settle(ref: InChatPaymentRef & { chargeId: string }): Promise<InChatPaidResult> {
    const found = await this.find(ref);
    if (!found) {
      this.logger.error(`in-chat paid for payment ${ref.paymentId} at a gateway that does not settle in chat (charge ${ref.chargeId})`);
      return { status: 'not_found', credited: null, currencyCode: null };
    }
    const { payment, provider } = found;

    if (ref.currency !== provider.chargeCurrency) {
      this.logger.error(`payment ${payment.id} paid in ${ref.currency}, charged in ${provider.chargeCurrency}: not settled`);
      return { status: 'unsettled', credited: null, currencyCode: null };
    }
    const received =
      ref.totalAmount === payment.chargedAmountMinor
        ? undefined
        : { amountMinor: ref.totalAmount, currency: ref.currency, decimals: provider.chargeDecimals };

    const credited = await this.settlement.creditVerified(
      payment,
      // The bot that relayed this shows the result in the chat itself (F-104-m).
      { referenceId: ref.chargeId, cardPan: null, shownInChat: true, ...(received ? { received } : {}) },
      ConfirmationSource.webhook_auto,
    );
    const after = await this.read(ref);
    const settled = after?.status === PaymentStatus.success;
    return {
      status: credited ? 'credited' : settled ? 'already_settled' : 'unsettled',
      credited: settled && after ? money(after.amountCredited) : null,
      currencyCode: settled && after ? after.currencyCode : null,
    };
  }

  /** As the guard reads it: a missing or unreadable state refuses nobody. */
  private async takesDeposits(tenantId: string, now: Date): Promise<boolean> {
    const state = parseTenantStatusState(await this.tenantStatus.get(UnscopedRedisKeys.tenantStatus(tenantId)));
    return !state || tenantAllows(state, 'endUserDeposit', now);
  }

  /**
   * The payment's tenant when the sender is its payer, through its own tenant's
   * bot — `null` when it is someone else (or a payment that recorded nobody),
   * `undefined` when there is no such payment.
   */
  private async tenantOf(ref: InChatPaymentRef): Promise<string | null | undefined> {
    const row = await this.crossTenant.paymentTransaction.findFirst({
      where: { id: ref.paymentId },
      select: { tenantId: true, payerChatPlatform: true, payerChatId: true },
    });
    if (!row?.tenantId) return undefined;
    const { sender } = ref;
    const isPayer =
      row.payerChatId !== null &&
      row.payerChatPlatform === sender.platform &&
      row.payerChatId === sender.senderId &&
      row.tenantId === sender.botTenantId;
    return isPayer ? row.tenantId : null;
  }

  /** The payment, in its tenant, at a gateway that settles in this messenger — or `null`, never a hint which. */
  private async find(ref: InChatPaymentRef): Promise<{ payment: InChatRow; provider: PaymentProvider } | null> {
    const payment = await this.read(ref);
    if (!payment) return null;
    const { providerName } = gatewayRefOf(payment);
    if (!this.providers.has(providerName)) return null;
    const provider = this.providers.get(providerName);
    return provider.settlement === 'in_chat' && provider.chatPlatform === ref.sender.platform ? { payment, provider } : null;
  }

  private read(ref: InChatPaymentRef): Promise<InChatRow | null> {
    return tenantTransaction(this.prisma, (tx) =>
      tx.paymentTransaction.findFirst({ where: { id: ref.paymentId }, select: IN_CHAT_SELECT }),
    );
  }
}
