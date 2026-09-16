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
}

/** The quote's and the start's body — the same body, on purpose (F-0612). */
export interface DepositBody {
  gatewayId: string;
  source: 'tenant' | 'platform';
  /** Base currency, a decimal string (ADR-0019) — billing validates it. */
  amount: string;
}

/** Money as decimal strings, exactly as billing answered. The bot does no arithmetic. */
export interface DepositQuote {
  amount: string;
  discount: string;
  fee: string;
  payable: string;
  credited: string;
  free: boolean;
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
   * units of `currency` (Stars). `null` for every other gateway.
   */
  invoice: { payload: string; currency: string; amountMinor: string } | null;
}

/** A messenger's payment event as billing takes it back (F-104-k); the amount as a string. */
export interface InChatPaymentBody {
  paymentId: string;
  currency: string;
  totalAmount: string;
}

export type PreCheckoutVerdict = { approved: true } | { approved: false; reason: 'not_found' | 'not_payable' | 'amount_mismatch' };

export interface InChatPaid {
  status: 'credited' | 'already_settled' | 'unsettled' | 'not_found';
  credited: string | null;
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
 */
@Injectable()
export class BillingApiClient {
  private readonly logger = new Logger(BillingApiClient.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService,
    private readonly copy: BotCopy,
  ) {
    this.baseUrl = (config.get<string>('BILLING_API_BASE_URL') ?? '').replace(/\/+$/, '');
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

  /** Relay a `pre_checkout_query` (F-104-m). */
  preCheckout(body: InChatPaymentBody, ctx: BillingCallContext): Promise<ApiResult<PreCheckoutVerdict>> {
    return this.call('POST', '/api/billing/deposit/in-chat/pre-checkout', body, ctx);
  }

  /** Relay a `successful_payment`, with the platform's charge id (F-104-m). */
  paid(body: InChatPaymentBody & { chargeId: string }, ctx: BillingCallContext): Promise<ApiResult<InChatPaid>> {
    return this.call('POST', '/api/billing/deposit/in-chat/paid', body, ctx);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body: unknown, ctx: BillingCallContext): Promise<ApiResult<T>> {
    if (!this.isConfigured) return this.unreachable(ctx.lang);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'accept-language': ctx.lang,
          authorization: `Bearer ${ctx.accessToken}`,
          [RequestHeaders.serviceToken]: this.serviceToken,
          [RequestHeaders.botPlatform]: ctx.platform,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (e: unknown) {
      this.logger.error(`billing ${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
      return this.unreachable(ctx.lang);
    } finally {
      clearTimeout(timer);
    }

    let envelope: ApiResult<T>;
    try {
      envelope = (await response.json()) as ApiResult<T>;
    } catch {
      this.logger.error(`billing ${method} ${path} answered ${response.status} with a non-JSON body`);
      return this.unreachable(ctx.lang);
    }
    // A refusal the gate wrote rather than billing (a 401, a 403 from the
    // policy file) carries no translated `msg`; every caller renders `msg` raw.
    if (typeof envelope?.ok !== 'boolean' || (!envelope.ok && !envelope.msg)) {
      this.logger.error(`billing ${method} ${path} answered ${response.status} with no envelope`);
      return this.unreachable(ctx.lang);
    }
    return envelope;
  }

  /** The same failure shape as `AuthApiClient`'s: a sentence, never a key. */
  private unreachable<T>(lang: string): ApiResult<T> {
    return { ok: false, msg: this.copy.text(lang, { key: BotKeys.common.tryAgain }) };
  }
}
