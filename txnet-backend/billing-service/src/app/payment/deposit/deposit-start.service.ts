import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CouponChannel,
  DomainVerificationStatus,
  PaymentStatus,
  Prisma,
  TenantDomainPurpose,
  TenantDomainType,
  WalletReasonType,
} from '@prisma/client';
import { TenantContext, panelHostOf, tenantTransaction } from '@txnet-backend/shared-core';
import { randomUUID } from 'node:crypto';

import type { EnvConfig } from '../../config/env.validation';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletLedgerService } from '../../wallet/wallet-ledger.service';
import { CouponReservationService } from '../coupon/coupon-reservation';
import { CouponValidationService } from '../coupon/coupon-validation';
import { GatewayMerchant, GatewaySource, MerchantGatewayRef } from '../gateway/gateway-merchant';
import { GatewayCredentials, GatewayFailure } from '../gateway/payment-provider';
import { PaymentProviderRegistry } from '../gateway/payment-provider.registry';
import { FxRateReader } from '../pricing/fx-rate.reader';
import { Chat } from './chat-platform';
import { offeredInThisChat, priceDeposit, selectGateway } from './deposit-pricing';
import { DepositGatewayNotFound, money } from './deposit-quote.service';
import { InvoiceLinkClient } from './invoice-link.client';
import { webhookUrlFor, withPaymentId } from './payment-callback-url';

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
  /** Where the top-up was started, and so where the codes were typed (F-502-k, F-306-a). Absent = the panel. */
  channel?: CouponChannel;
  /** The browser's `Origin` header — where the result page is, if it checks out. */
  origin?: string | null;
  /** The caller holds `gateway.manage`: its own switched-off gateways may take a test payment. */
  canTest?: boolean;
  /**
   * The messenger this caller is in — the bot (F-104-k) or its Mini App, by the
   * gate's `X-Chat-Platform` (F-104-q): an in-chat gateway starts only there —
   * and the payer's id in it, which an in-chat payment records (F-104-ab).
   */
  chat?: Chat | null;
  /** The request's language, for a Mini App's invoice text. */
  lang?: string;
  /**
   * A reseller's billing top-up (F-019-b, ADR-0056): the reseller whose billing
   * wallet the settled payment credits. The caller opens the platform owner's
   * scope, names a platform gateway and applies no coupon.
   */
  billingTenantId?: string;
};

/** Money as decimal strings in base currency, as the quote answers them. */
export type DepositStarted = {
  paymentId: string;
  /** Nothing was charged: the wallet is already credited and there is nowhere to send the user. */
  free: boolean;
  /** The gateway's own page. `null` on the free path and for an in-chat gateway. */
  redirectUrl: string | null;
  /**
   * What the bot puts in the invoice it sends (F-104-k), for an in-chat gateway
   * only: `payload` comes back in `pre_checkout_query` and `successful_payment`,
   * `amountMinor` is in `currency`'s smallest unit (whole Stars, rials).
   * `providerToken` is the gateway's `secretKey` — Bale's wallet token (F-104-n),
   * answered only to the bot that proved it is this gateway's messenger;
   * `null` for a provider that takes none (Stars). `null` otherwise.
   */
  invoice: { payload: string; currency: string; amountMinor: string; providerToken: string | null } | null;
  /**
   * For an in-chat gateway started from a Mini App (F-104-q): what the SDK's
   * `openInvoice` takes, made by the tenant's bot. `invoice` is then `null` —
   * a provider token is never answered to a browser. `null` otherwise.
   */
  invoiceLink: string | null;
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
const description = (paymentId: string, billing: boolean) =>
  billing ? `Billing wallet top-up ${paymentId}` : `Wallet top-up ${paymentId}`;

@Injectable()
export class DepositStartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly coupons: CouponValidationService,
    private readonly reservations: CouponReservationService,
    private readonly providers: PaymentProviderRegistry,
    private readonly merchant: GatewayMerchant,
    private readonly fx: FxRateReader,
    private readonly ledger: WalletLedgerService,
    private readonly config: ConfigService<EnvConfig, true>,
    private readonly links: InvoiceLinkClient,
  ) {}

  async start(request: DepositStartRequest): Promise<DepositStarted> {
    const tenant = TenantContext.current('deposit start');
    const { userId, gatewayId, amount, source } = request;

    // 1. Read: the gateway, the coupons as they stand, and where the bank will
    //    send the user back to. Nothing is held after this closes.
    const { gateway, coupons, callbackUrl, returnOrigin } = await tenantTransaction(this.prisma, async (tx) => {
      const gateway = await selectGateway(tx, this.crossTenant, tenant.id, gatewayId, source, { canTest: request.canTest });
      if (!gateway) throw new DepositGatewayNotFound(gatewayId, source);
      if (this.providers.has(gateway.providerName) && !offeredInThisChat(this.providers.get(gateway.providerName), gateway, request.chat?.platform ?? null)) {
        throw new DepositGatewayNotFound(gatewayId, source);
      }
      const coupons = await this.coupons.validate(tx, {
        codes: request.couponCodes,
        amount,
        target: { kind: 'wallet_top_up' },
        gatewaySource: source,
        gatewayId,
        // `bot` when the bot's top-up called (F-306-a, `DepositController.channelOf`).
        channel: request.channel ?? CouponChannel.panel,
        userId,
      });
      return {
        gateway,
        coupons,
        callbackUrl: gateway.callbackUrl ?? (await this.callbackUrl(tx, tenant.id)),
        returnOrigin: await this.returnOrigin(tx, tenant.id, request.origin),
      };
    });

    const ref: MerchantGatewayRef = {
      // Whose vault holds the merchant id: this tenant for a gateway it owns,
      // the lender for one granted to it (ADR-0041 §3, F-096-b).
      tenantId: gateway.ownerTenantId,
      source,
      gatewayId: gateway.id,
      providerName: gateway.providerName,
      grantId: gateway.grantId,
    };
    const { provider, price } = await priceDeposit(
      { providers: this.providers, merchant: this.merchant, fx: this.fx },
      { gateway, ref, amount, discount: coupons.totalDiscount, actorId: userId },
    );

    // A gateway that will be paid needs somewhere to answer; a free top-up does
    // not, so it is never refused for a domain it will not use.
    // An in-chat payment has no bank to send anyone back: the bot relays its result (F-104-k).
    const inChat = provider.settlement === 'in_chat';
    if (!price.free && !inChat && !callbackUrl) throw new DepositCallbackUnavailable(tenant.id);
    // The row's CHECK allows a billing top-up only on a platform gateway with no
    // discount, so it is never free and never in chat (no coupon, no messenger).
    if (request.billingTenantId && (price.free || inChat || source !== 'platform' || gateway.grantId)) {
      throw new DepositGatewayNotFound(gatewayId, source);
    }

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
          // Which grant this payment was taken under, or NULL for a gateway the
          // tenant owns (F-096-a). It is written here rather than at settlement
          // because the grant can be withdrawn between the two, and what the
          // platform owes is decided by the grant the payment was *made* under
          // (ADR-0041 §4); F-096-d accrues from this column.
          grantId: gateway.grantId,
          billingTenantId: request.billingTenantId ?? null,
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
          returnOrigin,
          // Where it was started (F-306-a): the payer notice tells a bot payer
          // even about a webhook credit, since no success page is in front of them.
          channel: request.channel ?? CouponChannel.panel,
          // Whose messenger events may settle it (F-104-ab): the relay is
          // admitted only from this sender. An in-chat start always has one.
          ...(inChat && request.chat ? { payerChatPlatform: request.chat.platform, payerChatId: request.chat.payerId } : {}),
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
      invoice: null,
      invoiceLink: null,
      amount: money(price.amount),
      discount: money(price.discount),
      fee: money(price.fee),
      payable: money(price.payable),
      credited: money(price.credited),
      balance: balance ? money(balance) : null,
    };
    if (price.free) return answer;

    // In chat, nothing is minted: the bot sends the invoice with its own token,
    // and `pre-checkout` gives the row its authority (`DepositInChatService`).
    // A provider token (Bale's wallet, F-104-n) goes to the bot in the answer; a
    // vault miss fails the payment the way a bank that will not mint does.
    if (inChat) {
      let credentials: GatewayCredentials;
      try {
        credentials = await this.merchant.credentialsFor(ref, userId);
      } catch (e) {
        await this.abandon(paymentId, e);
        throw e;
      }
      const invoice = {
        payload: paymentId,
        currency: provider.chargeCurrency,
        amountMinor: (price.chargedAmountMinor as bigint).toString(),
        providerToken: credentials.secretKey ?? null,
      };
      if (request.channel === CouponChannel.bot) return { ...answer, invoice };

      // A Mini App (F-104-q): the tenant's bot makes the link the SDK opens,
      // and the token stays on the internal hop. No link fails it like no mint.
      const link = await this.links.create({
        tenantId: tenant.id,
        platform: (request.chat as Chat).platform,
        paymentId,
        currency: invoice.currency,
        amountMinor: invoice.amountMinor,
        providerToken: invoice.providerToken,
        credited: answer.credited,
        lang: request.lang ?? 'en',
      });
      if (!link) {
        const failure = new GatewayFailure(provider.name, 'unavailable', null, 'bot-service made no invoice link');
        await this.abandon(paymentId, failure);
        throw failure;
      }
      return { ...answer, invoiceLink: link };
    }

    // 3. The bank. Outside every transaction, and never retried.
    const credentials = await this.merchant.credentialsFor(ref, userId);
    let minted: { authority: string; redirectUrl: string };
    try {
      minted = await provider.request({
        credentials,
        amountMinor: price.chargedAmountMinor as bigint,
        // Names the payment, so a lost authority write can be found again (F-092-ad).
        callbackUrl: withPaymentId(callbackUrl as string, paymentId),
        // A webhook provider told per payment where to post (NOWPayments, OxaPay).
        ...(provider.settlement === 'webhook'
          ? { webhookUrl: webhookUrlFor(callbackUrl as string, this.config.get('GLOBAL_PREFIX', { infer: true }), ref) }
          : {}),
        description: description(paymentId, Boolean(request.billingTenantId)),
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
   * The panel origin the result page is on: the browser's `Origin`, kept only
   * when CORS already trusts it (`FRONTEND_ORIGIN`) or it is one of this
   * tenant's proven panel hosts. The callback can land on a relay or the API
   * host, so a relative redirect would miss the panel; an origin nobody vouches
   * for is dropped rather than becoming an open redirect.
   */
  private async returnOrigin(
    tx: Prisma.TransactionClient,
    tenantId: string,
    origin: string | null | undefined,
  ): Promise<string | null> {
    let parsed: URL;
    try {
      parsed = new URL(origin ?? '');
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

    const allowed = this.config
      .get('FRONTEND_ORIGIN', { infer: true })
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    if (allowed.includes(parsed.origin)) return parsed.origin;

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
      orderBy: [{ domainType: 'desc' }, { domainValue: 'asc' }],
    });
    return parsed.protocol === 'https:' && rows.some((r) => r.domainValue === parsed.host) ? parsed.origin : null;
  }

  /**
   * Where the gateway sends the user back to when the gateway names no address
   * of its own (`callbackUrl`, F-092-w — an operator whose terminal is
   * registered on another domain writes it, and it is sent verbatim) — the tenant's own panel host
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
    // A reseller's platform subdomain serves nothing (ADR-0063), so a payer is
    // returned only to its own domain; with none, the deposit is refused before
    // a payment exists (F-018-aj).
    const owner = await tx.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
    if (!owner) return null;
    const host = panelHostOf(rows, owner.tenantType);
    return host ? `https://${host}${path}` : null;
  }
}
