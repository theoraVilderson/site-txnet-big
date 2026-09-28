import { BotPlatform } from '@txnet-backend/messenger';
import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiResult } from '../auth-api/auth-api.types';
import { BotCopy } from '../locale/bot-copy';
import { BotKeys } from '../locale/bot-keys';

/** One gateway as `GET /api/billing/deposit/gateways` lists it (`billing/contract.deposit.md`). */
export interface DepositGateway {
  id: string;
  source: 'tenant' | 'platform';
  displayName: string;
  providerName: string;
  category: string;
  minAmount: string | null;
  maxAmount: string | null;
  /** The gateway's quick amounts (F-092-v); empty = none to offer. */
  presets: string[];
  /** What the limits and presets are in (F-116-h2); the payment's currency, since only those are listed. */
  currencyCode: string;
}

/** The quote's and the start's body — the same body, on purpose (F-0612). */
export interface DepositBody {
  gatewayId: string;
  source: 'tenant' | 'platform';
  /** In the gateway's `currencyCode`, a decimal string — billing validates it. */
  amount: string;
}

/** Money as decimal strings, exactly as billing answered. The bot does no arithmetic. */
export interface DepositQuote {
  amount: string;
  discount: string;
  fee: string;
  /** Added on top of the fee (ADR-0076); `"0.00"` when the top-up is not taxed. */
  tax: string;
  /** The rate `tax` was charged at; `null` = no tax. */
  taxRatePercent: string | null;
  payable: string;
  credited: string;
  free: boolean;
  /** What every figure above is in (F-116-h2) — shown beside each one (F-116-h4). */
  currencyCode: string;
}

export interface DepositStarted extends DepositQuote {
  paymentId: string;
  /** The gateway's own page; `null` on a fully discounted top-up. */
  redirectUrl: string | null;
  /** The new balance, on the free path only. */
  balance: string | null;
  /**
   * What the chat's invoice carries, for a gateway paid inside the chat (F-104-k):
   * the payload comes back with the payment's events, `amountMinor` is whole
   * units of `currency` (Stars, rials), `providerToken` the gateway's own (Bale's
   * wallet, F-104-n) or `null`. `null` for every other gateway.
   */
  invoice: { payload: string; currency: string; amountMinor: string; providerToken: string | null } | null;
}

/**
 * A messenger's payment event as billing takes it back (F-104-k); the amount as
 * a string. The sender and this bot's tenant are what billing matches the
 * payment's payer on (F-104-ab) — no chat session is involved.
 */
export interface InChatPaymentBody {
  paymentId: string;
  currency: string;
  totalAmount: string;
  platform: BotPlatform;
  /** The messenger id of whoever the platform says is paying. */
  senderId: string;
  /** The tenant of the bot the event arrived at. */
  botTenantId: string;
}

export type PreCheckoutVerdict = { approved: true } | { approved: false; reason: 'not_found' | 'not_payable' | 'amount_mismatch' };

export interface InChatPaid {
  status: 'credited' | 'already_settled' | 'unsettled' | 'not_found';
  credited: string | null;
  /** The payment's currency, what `credited` is in (F-116-h4); absent from an older billing. */
  currencyCode?: string | null;
}

/**
 * What one reseller earned over a period, as
 * `GET /api/billing/tenants/:tenantId/revenue` answers it
 * (`billing/contract.revenue.md`, F-311-b, ADR-0067).
 *
 * **Two figures, and neither is the other**: `sales` is what this reseller's
 * users spent on its services, `topUps` what they paid into their wallets. The
 * window echoed back is the one billing actually used, so the bot renders the
 * dates it was given rather than restating the ones it sent. Every amount is a
 * base-currency decimal string — the bot does no arithmetic on any of them.
 *
 * `sales.total` is `0.00` until `entitlement` is built and something writes a
 * `traffic_consumption` row. That is why this screen labels both figures
 * rather than adding them: a zero labelled "revenue" reads as a bug, and
 * "service sales" plus "customer top-ups" reads as what it is.
 */
export interface ResellerRevenue {
  from: string;
  to: string;
  sales: { total: string; count: number; byReason: { reasonType: string; total: string; count: number }[] };
  topUps: { total: string; count: number };
}

/** Whose call this is: the chat's access token, in the chat's language. */
export interface BillingCallContext {
  lang: string;
  accessToken: string;
  /**
   * The messenger this chat is on. Sent as `X-Bot-Platform`, which billing
   * believes only beside the service token: it is what offers a gateway paid
   * inside this messenger's chat (F-104-k) and no other.
   */
  platform: BotPlatform;
  /**
   * The tenant of the bot the update arrived at, sent as `X-Bot-Tenant-Id`
   * beside the service token. Billing offers this chat an in-chat gateway only
   * for a payment of that tenant: the invoice is paid to this bot (F-061-j).
   */
  botTenantId: string;
}

/**
 * The bot's way into billing (F-306-a) — the panel's own deposit routes, reached
 * **through the gate** exactly as the panel reaches them.
 *
 * The chat's access token is the Bearer, so `my-auth` proves the user and
 * forwards the identity and tenant headers billing trusts; nothing on this side
 * names a user or a tenant. `X-Service-Token` rides along for one reason only:
 * billing records a payment whose token checks out as started from the `bot`
 * channel (coupon limits, and the payer notice on settlement). It identifies
 * the caller as this service, never anyone on whose behalf it acts.
 *
 * `BILLING_API_BASE_URL` is optional: unset, the member menu offers no top-up
 * rather than a button that fails (`isConfigured`).
 *
 * **The in-chat relay is the exception (F-104-ab).** A payment's events are
 * the payment's, not the chat's: the payer may never have signed in here. So
 * `preCheckout` / `paid` go to billing directly at `BILLING_INTERNAL_BASE_URL`
 * (`/api/internal/*`, not routed by Traefik) with the service token alone and
 * the sender in the body. Unset, they answer "try again" — the platform then
 * cancels the query, and a `paid` stays verifying for a person.
 */
@Injectable()
export class BillingApiClient {
  private readonly logger = new Logger(BillingApiClient.name);
  private readonly baseUrl: string;
  private readonly internalBaseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService,
    private readonly copy: BotCopy,
  ) {
    this.baseUrl = (config.get<string>('BILLING_API_BASE_URL') ?? '').replace(/\/+$/, '');
    this.internalBaseUrl = (config.get<string>('BILLING_INTERNAL_BASE_URL') ?? '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 8000);
  }

  get isConfigured(): boolean {
    return this.baseUrl !== '';
  }

  listGateways(ctx: BillingCallContext): Promise<ApiResult<DepositGateway[]>> {
    return this.call('GET', '/api/billing/deposit/gateways', undefined, ctx);
  }

  quote(body: DepositBody, ctx: BillingCallContext): Promise<ApiResult<DepositQuote>> {
    return this.call('POST', '/api/billing/deposit/quote', body, ctx);
  }

  start(body: DepositBody, ctx: BillingCallContext): Promise<ApiResult<DepositStarted>> {
    return this.call('POST', '/api/billing/deposit/start', body, ctx);
  }

  /**
   * A named reseller's own takings (F-311-b). The reseller is the **path's**,
   * never the session's: its owner signs in to the platform owner's tenant
   * (ADR-0059), so a call that named no reseller would total the wrong one.
   *
   * No period is sent — billing's default window is the month a reseller is
   * asked about most, and the answer says which window it used.
   */
  resellerRevenue(tenantId: string, ctx: BillingCallContext): Promise<ApiResult<ResellerRevenue>> {
    return this.call('GET', `/api/billing/tenants/${tenantId}/revenue`, undefined, ctx);
  }

  /** Relay a `pre_checkout_query` (F-104-m, F-104-ab). */
  preCheckout(body: InChatPaymentBody, lang: string): Promise<ApiResult<PreCheckoutVerdict>> {
    return this.relay('/api/internal/billing/deposit/in-chat/pre-checkout', body, lang);
  }

  /** Relay a `successful_payment`, with the platform's charge id (F-104-m, F-104-ab). */
  paid(body: InChatPaymentBody & { chargeId: string }, lang: string): Promise<ApiResult<InChatPaid>> {
    return this.relay('/api/internal/billing/deposit/in-chat/paid', body, lang);
  }

  private call<T>(method: 'GET' | 'POST', path: string, body: unknown, ctx: BillingCallContext): Promise<ApiResult<T>> {
    if (!this.isConfigured) return Promise.resolve(this.unreachable(ctx.lang));
    return this.send(method, `${this.baseUrl}${path}`, body, ctx.lang, {
      authorization: `Bearer ${ctx.accessToken}`,
      [RequestHeaders.serviceToken]: this.serviceToken,
      [RequestHeaders.botPlatform]: ctx.platform,
      [RequestHeaders.botTenantId]: ctx.botTenantId,
    });
  }

  private relay<T>(path: string, body: InChatPaymentBody, lang: string): Promise<ApiResult<T>> {
    if (!this.internalBaseUrl) {
      this.logger.error(`billing relay ${path}: BILLING_INTERNAL_BASE_URL is unset`);
      return Promise.resolve(this.unreachable(lang));
    }
    return this.send('POST', `${this.internalBaseUrl}${path}`, body, lang, { [RequestHeaders.serviceToken]: this.serviceToken });
  }

  private async send<T>(
    method: 'GET' | 'POST',
    url: string,
    body: unknown,
    lang: string,
    auth: Record<string, string>,
  ): Promise<ApiResult<T>> {
    const path = new URL(url).pathname;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', 'accept-language': lang, ...auth },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (e: unknown) {
      this.logger.error(`billing ${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
      return this.unreachable(lang);
    } finally {
      clearTimeout(timer);
    }

    let envelope: ApiResult<T>;
    try {
      envelope = (await response.json()) as ApiResult<T>;
    } catch {
      this.logger.error(`billing ${method} ${path} answered ${response.status} with a non-JSON body`);
      return this.unreachable(lang);
    }
    // A refusal the gate wrote rather than billing (a 401, a 403 from the
    // policy file) carries no translated `msg`; every caller renders `msg` raw.
    if (typeof envelope?.ok !== 'boolean' || (!envelope.ok && !envelope.msg)) {
      this.logger.error(`billing ${method} ${path} answered ${response.status} with no envelope`);
      return this.unreachable(lang);
    }
    return envelope;
  }

  /** The same failure shape as `AuthApiClient`'s: a sentence, never a key. */
  private unreachable<T>(lang: string): ApiResult<T> {
    return { ok: false, msg: this.copy.text(lang, { key: BotKeys.common.tryAgain }) };
  }
}
