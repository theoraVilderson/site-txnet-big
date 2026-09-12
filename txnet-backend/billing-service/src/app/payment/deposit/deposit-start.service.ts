import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DomainVerificationStatus,
  PaymentStatus,
  Prisma,
  TenantDomainPurpose,
  TenantDomainType,
  WalletReasonType,
} from '@prisma/client';
import { TenantContext, tenantTransaction } from '@txnet-backend/shared-core';
import { randomUUID } from 'node:crypto';

import type { EnvConfig } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletLedgerService } from '../../wallet/wallet-ledger.service';
import { CouponReservationService } from '../coupon/coupon-reservation';
import { CouponValidationService } from '../coupon/coupon-validation';
import { GatewayMerchant, GatewaySource, MerchantGatewayRef } from '../gateway/gateway-merchant';
import { GatewayFailure } from '../gateway/payment-provider';
import { PaymentProviderRegistry } from '../gateway/payment-provider.registry';
import { FxRateReader } from '../pricing/fx-rate.reader';
import { priceDeposit, selectGateway } from './deposit-pricing';
import { DepositGatewayNotFound, money } from './deposit-quote.service';

/**
 * Starting a top-up (F-092-i) — the first billing route that writes money.
 *
 * The order is the whole of this file, and it is not the legacy one. A payment
 * is priced, its coupons are **held** and the `payment_transaction` row written
 * — all before the gateway is asked to mint an authority. `request` is never
 * retried (`payment-provider.ts`) because every attempt mints one, so a refusal
 * that arrives after the bank has been called is an authority nobody will pay
 * and a hold nobody gave back. Legacy called the gateway first and created the
 * transaction afterwards, which is the same bug from the other end: a paid
 * authority with no row to settle it against.
 *
 * Three transactions, and none of them is open while a bank is on the phone:
 *  1. the gateway row, the coupons, and the host the bank will send the user
 *     back to — a read;
 *  2. the payment row and its coupon holds — one commit, or nothing;
 *  3. the authority, once the gateway has answered with one.
 * Between 2 and 3 sits the only call that can leave work half-done: a request
 * that succeeded but whose authority was not stored. That payment is `pending`
 * with no tracking code, which is exactly what reconciliation (F-092-l) and the
 * expiry job (F-092-k) are for — a row that cannot be found is worse than a row
 * that is found late.
 *
 * **The free path.** A top-up whose payable comes to zero reaches no gateway at
 * all: the wallet is credited, the holds become uses and the payment is written
 * `success`, in transaction 2 and nowhere else (billing invariants 1-3). It is
 * the one path that asks neither the vault nor the provider.
 *
 * `amount` is base currency, as the quote takes it. The legacy `amount * 10`
 * toman→rial step that ran in the browser is gone: converting for the gateway
 * happens once, inside `priceAtGateway`, with the rate snapshot the row records
 * (ADR-0019, invariant 12). Converting a **display** currency into the base one
 * is F-025's, and arrives in front of this.
 */

export type DepositStartRequest = {
  userId: string;
  gatewayId: string;
  source: GatewaySource;
  /** Base currency (ADR-0019), > 0, at most 2 decimal places. */
  amount: Prisma.Decimal;
  couponCodes: readonly string[];
};

/** Money as decimal strings in base currency, as the quote answers them. */
export type DepositStarted = {
  paymentId: string;
  /** Nothing was charged: the wallet is already credited and there is nowhere to send the user. */
  free: boolean;
  /** The gateway's own page. `null` on the free path. */
  redirectUrl: string | null;
  amount: string;
  discount: string;
  fee: string;
  payable: string;
  credited: string;
  /** The wallet balance a free top-up left behind; `null` when a gateway still has to be paid. */
  balance: string | null;
};

/**
 * The bank has nowhere to send the user back to: this tenant has no panel
 * domain it owns — no platform subdomain, and no custom domain whose ownership
 * has been proven.
 *
 * Refused rather than guessed. The callback is a public route resolved by Host
 * (ADR-0020, F-092-j), so a host this tenant does not own is either a payment
 * that lands on somebody else's panel or one that lands nowhere.
 */
export class DepositCallbackUnavailable extends Error {
  constructor(readonly tenantId: string) {
    super(`tenant ${tenantId} has no verified panel domain to receive a gateway callback`);
    this.name = 'DepositCallbackUnavailable';
  }
}

/** What a driver is told the payment is for. English (C-01); legacy carried the user's phone in a Persian sentence. */
const description = (paymentId: string) => `Wallet top-up ${paymentId}`;

@Injectable()
export class DepositStartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coupons: CouponValidationService,
    private readonly reservations: CouponReservationService,
    private readonly providers: PaymentProviderRegistry,
    private readonly merchant: GatewayMerchant,
    private readonly fx: FxRateReader,
    private readonly ledger: WalletLedgerService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  async start(request: DepositStartRequest): Promise<DepositStarted> {
    const tenant = TenantContext.current('deposit start');
    const { userId, gatewayId, amount, source } = request;

    // 1. Read: the gateway, the coupons as they stand, and where the bank will
    //    send the user back to. Nothing is held after this closes.
    const { gateway, coupons, callbackUrl } = await tenantTransaction(this.prisma, async (tx) => {
      const gateway = await selectGateway(tx, tenant.id, gatewayId, source);
      if (!gateway) throw new DepositGatewayNotFound(gatewayId, source);
      const coupons = await this.coupons.validate(tx, {
        codes: request.couponCodes,
        amount,
        target: { kind: 'wallet_top_up' },
        userId,
      });
      return { gateway, coupons, callbackUrl: await this.callbackUrl(tx, tenant.id) };
    });

    const ref: MerchantGatewayRef = {
      tenantId: tenant.id,
      source,
      gatewayId: gateway.id,
      providerName: gateway.providerName,
    };
    const { provider, price } = await priceDeposit(
      { providers: this.providers, merchant: this.merchant, fx: this.fx },
      { gateway, ref, amount, discount: coupons.totalDiscount, actorId: userId },
    );

    // A gateway that will be paid needs somewhere to answer; a free top-up does
    // not, so it is never refused for a domain it will not use.
    if (!price.free && !callbackUrl) throw new DepositCallbackUnavailable(tenant.id);

    // The id is minted here because the holds name it: `reserve` takes the
    // order reference, and for a top-up that reference is the payment itself,
    // which is what lets F-092-j confirm and F-092-k expire them by id.
    const paymentId = randomUUID();
    const ttl = this.config.get('PAYMENT_PENDING_TTL_SEC', { infer: true });

    // 2. Write: the payment and its holds, together or not at all. A refused
    //    hold aborts this whole transaction, and the panel re-quotes.
    const balance = await tenantTransaction(this.prisma, async (tx) => {
      await tx.paymentTransaction.create({
        data: {
          id: paymentId,
          userId,
          ...(source === 'platform' ? { gatewayId: gateway.id } : { tenantGatewayConfigId: gateway.id }),
          amountRequested: price.amount,
          feeApplied: price.fee,
          discountApplied: price.discount,
          amountCredited: price.credited,
          // Non-null on the column, and the free path charges nobody anything.
          chargedAmountMinor: price.chargedAmountMinor ?? BigInt(0),
          // The pair, or neither: a rate with no snapshot is the state ADR-0019
          // says a rial invoice must never be in (invariant 12).
          exchangeRateSnapshot: price.rate,
          exchangeRateSnapshotId: price.rateSnapshotId,
          status: price.free ? PaymentStatus.success : PaymentStatus.pending,
          // A hold has no clock of its own: it lives as long as its payment,
          // and a payment that has already landed never expires.
          expiresAt: price.free ? null : new Date(Date.now() + ttl * 1000),
        },
        select: { id: true },
      });
      await this.reservations.reserve(tx, {
        userId,
        orderReferenceId: paymentId,
        paymentTransactionId: paymentId,
        applied: coupons.applied,
      });
      if (!price.free) return null;
      // Nothing will ever confirm this one, so it confirms itself: the credit
      // and the uses commit together or neither does (invariants 1-3, 11).
      const entry = await this.ledger.credit(tx, {
        userId,
        amount: price.credited,
        reasonType: WalletReasonType.payment_gateway,
        referenceId: paymentId,
      });
      await this.reservations.confirm(tx, paymentId);
      return entry.balanceAfter;
    });

    const answer: DepositStarted = {
      paymentId,
      free: price.free,
      redirectUrl: null,
      amount: money(price.amount),
      discount: money(price.discount),
      fee: money(price.fee),
      payable: money(price.payable),
      credited: money(price.credited),
      balance: balance ? money(balance) : null,
    };
    if (price.free) return answer;

    // 3. The bank. Outside every transaction, and never retried.
    const credentials = await this.merchant.credentialsFor(ref, userId);
    let minted: { authority: string; redirectUrl: string };
    try {
      minted = await provider.request({
        credentials,
        amountMinor: price.chargedAmountMinor as bigint,
        callbackUrl: callbackUrl as string,
        description: description(paymentId),
      });
    } catch (e) {
      await this.abandon(paymentId, e);
      throw e;
    }

    await tenantTransaction(this.prisma, (tx) =>
      tx.paymentTransaction.update({
        where: { id: paymentId },
        // ADR-0028: for Zarinpal the tracking code is the `authority`, not the
        // receipt number — it is what a duplicate callback shares.
        data: { gatewayTrackingCode: minted.authority },
      }),
    );

    return { ...answer, redirectUrl: minted.redirectUrl };
  }

  /**
   * The gateway would not mint: the payment never existed as far as the bank is
   * concerned, so it is `failed` and its holds go back. `cancelled`, not
   * `expired` — nothing timed out.
   */
  private async abandon(paymentId: string, cause: unknown): Promise<void> {
    const failureCode = cause instanceof GatewayFailure ? cause.reason : 'unavailable';
    await tenantTransaction(this.prisma, async (tx) => {
      await tx.paymentTransaction.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.failed, failureCode },
      });
      await this.reservations.release(tx, paymentId, 'cancelled');
    });
  }

  /**
   * Where the gateway sends the user back to — the tenant's own panel host
   * (ADR-0020), never the platform's and never a header the client set.
   *
   * A proven custom domain wins: it is the brand the user chose to pay on, and
   * a bank's redirect back to a different host reads as a failed payment. A
   * platform subdomain is issued by us, so matching the row is the whole proof;
   * a custom one is only the tenant's once ownership has been shown, which is
   * the same rule `auth-service`'s resolver applies to an incoming Host.
   *
   * `PAYMENT_CALLBACK_ORIGIN` overrides all of it with one origin for every
   * tenant — a development and test affordance, where no tenant owns a host
   * that a bank's sandbox could reach.
   */
  private async callbackUrl(tx: Prisma.TransactionClient, tenantId: string): Promise<string | null> {
    const prefix = this.config.get('GLOBAL_PREFIX', { infer: true });
    const path = `/${prefix}/billing/deposit/callback`;

    const override = this.config.get('PAYMENT_CALLBACK_ORIGIN', { infer: true });
    if (override) return `${override.replace(/\/+$/, '')}${path}`;

    const rows = await tx.tenantDomain.findMany({
      where: {
        tenantId,
        purpose: TenantDomainPurpose.panel,
        OR: [
          { domainType: TenantDomainType.subdomain },
          { verificationStatus: DomainVerificationStatus.verified },
        ],
      },
      select: { domainValue: true, domainType: true },
      // Deterministic, so two payments of one tenant never disagree about the
      // host: proven custom domains first, then alphabetically.
      orderBy: [{ domainType: 'desc' }, { domainValue: 'asc' }],
    });
    const host = rows[0]?.domainValue;
    return host ? `https://${host}${path}` : null;
  }
}
