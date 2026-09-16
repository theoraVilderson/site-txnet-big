import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { PaymentProviderName, Prisma } from '@prisma/client';

import { paymentIdInUrl } from '../deposit/payment-callback-url';
import {
  FeeQuote,
  FeeQuoteInput,
  GatewayCredentials,
  GatewayFailure,
  GatewayFailureReason,
  PaymentInquiryInput,
  PaymentInquiryResult,
  PaymentProvider,
  PaymentRequestInput,
  PaymentRequestResult,
  PaymentVerifyInput,
  PaymentVerifyResult,
  WebhookEvent,
  WebhookInput,
  WebhookSignatureInvalid,
} from './payment-provider';

export type AirwallexOptions = {
  /** The sandbox API and checkout hosts — per environment, never per tenant. */
  sandbox: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Epoch ms; the token clock and the webhook's replay window read it. */
  now?: () => number;
};

const HOSTS = {
  live: { api: 'https://api.airwallex.com', checkout: 'https://checkout.airwallex.com' },
  sandbox: { api: 'https://api.sandbox.airwallex.com', checkout: 'https://checkout.sandbox.airwallex.com' },
};

/** How far a webhook's `x-timestamp` may be from our clock before it is a replay. */
const WEBHOOK_TOLERANCE_MS = 5 * 60_000;
/** A token is dropped this long before `expires_at`, so a call never starts on one about to lapse. */
const TOKEN_MARGIN_MS = 60_000;
/** When `expires_at` cannot be read: the documented lifetime, less a margin. */
const TOKEN_FALLBACK_MS = 25 * 60_000;
/** Attempts for a read that is safe to repeat. */
const READ_ATTEMPTS = 2;

/** Events about an intent that is neither paid nor finished. `payment_failed`: see the class comment. */
const PENDING_EVENTS = new Set([
  'payment_intent.created',
  'payment_intent.updated',
  'payment_intent.requires_payment_method',
  'payment_intent.requires_customer_action',
  'payment_intent.requires_capture',
  'payment_intent.pending',
  'payment_intent.pending_review',
  'payment_intent.payment_failed',
]);

type Intent = { id?: unknown; status?: unknown; amount?: unknown; currency?: unknown; client_secret?: unknown; latest_payment_attempt?: unknown };
type Token = { value: string; expiresAt: number };

/**
 * Airwallex (F-104-j, D-32): a PaymentIntent on the hosted payment page,
 * settled by webhook. Checked against airwallex.com/docs 2026-09-16.
 *
 * - Credentials: client id in the `merchantId` slot, API key in `secretKey`
 *   (`provider-fields.ts`). `POST /api/v1/authentication/login` answers a
 *   30-minute bearer token, **cached in this process by a SHA-256 of the pair**
 *   — never the keys themselves. Only a call presenting the very keys that
 *   could log in for a token gets it, so no other gateway or tenant can; a
 *   rotated key misses and logs in. A 401 on a cached token logs in once more.
 * - `request` creates the intent in USD (`request_id` is Airwallex's
 *   idempotency key, so a re-login retry reuses it; silence is never retried).
 *   Authority = intent id, reference = its latest attempt id.
 * - **The hosted page has no documented server-side URL**: the docs send the
 *   payer there only through the browser SDK's `redirectToCheckout`. This
 *   builds the URL that SDK builds (read from checkout.airwallex.com's bundle
 *   2026-09-16): `<checkout>/#/standalone/checkout?intent_id&client_secret&currency&successUrl&failUrl`.
 *   The spec pins that shape; if Airwallex moves it, that is where it shows.
 * - A webhook carries `x-timestamp` (ms) and `x-signature` = HMAC-SHA256 hex
 *   over timestamp + raw body with the notification URL's secret; outside
 *   ±5 minutes it is a replay. The webhook URL is set once per subscription in
 *   Airwallex's dashboard, not per payment.
 * - `payment_intent.succeeded` is paid (the intent's amount; no receipt is
 *   reported), `.cancelled` failed. **`payment_failed` is pending**: it is one
 *   attempt, and the hosted page lets the payer try another card. Refund events
 *   are ignored — they carry a refund amount, not whether the whole payment went back.
 * - `inquire` / `verify` read `GET /api/v1/pa/payment_intents/{id}`. No fee API.
 */
export class AirwallexProvider implements PaymentProvider {
  readonly name = PaymentProviderName.airwallex;
  readonly chargeCurrency = 'USD';
  readonly chargeDecimals = 2;
  readonly verifyWindowSec = null;
  readonly settlement = 'webhook' as const;

  private readonly hosts: (typeof HOSTS)['live'];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly tokens = new Map<string, Token>();

  constructor(options: AirwallexOptions) {
    this.hosts = options.sandbox ? HOSTS.sandbox : HOSTS.live;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? Date.now;
  }

  async request(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    const keys = this.keysOf(input.credentials);
    const cents = input.amountMinor;
    if (cents <= BigInt(0) || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw this.failure('invalid_request', null, 'amount is not a positive whole number of cents');
    }
    const requestId = randomUUID();
    const intent = (await this.call(keys, 'POST', '/api/v1/pa/payment_intents/create', {
      request_id: requestId,
      amount: Number(new Prisma.Decimal(cents.toString()).div(100).toString()),
      currency: 'USD',
      merchant_order_id: paymentIdInUrl(input.callbackUrl) ?? requestId,
      return_url: input.callbackUrl,
      descriptor: input.description,
    })) as Intent;
    if (typeof intent.id !== 'string' || !intent.id) throw this.failure('unexpected', null, 'intent answer has no id');
    if (typeof intent.client_secret !== 'string') throw this.failure('unexpected', null, 'intent answer has no client_secret');

    const query = new URLSearchParams({
      intent_id: intent.id,
      client_secret: intent.client_secret,
      currency: 'USD',
      successUrl: input.callbackUrl,
      failUrl: input.callbackUrl,
    });
    return { authority: intent.id, redirectUrl: `${this.hosts.checkout}/#/standalone/checkout?${query.toString()}` };
  }

  verifyWebhook(input: WebhookInput): WebhookEvent {
    const timestamp = headerOf(input, 'x-timestamp');
    const signature = headerOf(input, 'x-signature');
    if (!timestamp || !signature) throw new WebhookSignatureInvalid(this.name, 'no x-timestamp or x-signature header');
    const expected = createHmac('sha256', input.secret).update(timestamp).update(input.rawBody).digest();
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new WebhookSignatureInvalid(this.name, 'signature does not match');
    }
    const at = Number(timestamp);
    if (!Number.isFinite(at) || Math.abs(this.now() - at) > WEBHOOK_TOLERANCE_MS) {
      throw new WebhookSignatureInvalid(this.name, 'timestamp outside the tolerance');
    }

    let body: { name?: unknown; data?: { object?: Intent } };
    try {
      body = JSON.parse(input.rawBody.toString('utf8')) as typeof body;
    } catch {
      // Signed, and still not JSON: nothing here to act on.
      return { kind: 'ignored', type: 'unparseable' };
    }
    const name = String(body.name ?? '');
    const intent = body.data?.object;
    if (!name.startsWith('payment_intent.') || typeof intent?.id !== 'string' || !intent.id) return { kind: 'ignored', type: name };
    const authority = intent.id;

    if (name === 'payment_intent.succeeded') return { kind: 'paid', authority, referenceId: attemptOf(intent) ?? authority };
    if (name === 'payment_intent.cancelled') return { kind: 'failed', authority };
    if (PENDING_EVENTS.has(name)) return { kind: 'pending', authority };
    return { kind: 'ignored', type: name };
  }

  async inquire(input: PaymentInquiryInput): Promise<PaymentInquiryResult> {
    const status = String((await this.intent(input.credentials, input.authority)).status ?? '').toUpperCase();
    if (status === 'SUCCEEDED') return { status: 'verified' };
    if (status === 'CANCELLED') return { status: 'failed' };
    return { status: 'in_bank' };
  }

  async verify(input: PaymentVerifyInput): Promise<PaymentVerifyResult> {
    const intent = await this.intent(input.credentials, input.authority);
    const status = String(intent.status ?? '').toUpperCase();
    if (status !== 'SUCCEEDED') {
      throw this.failure(status === 'CANCELLED' ? 'payment_failed' : 'unavailable', status || null, `intent ${status}`);
    }
    const amount = decimalOf(intent.amount);
    const asked = new Prisma.Decimal(input.amountMinor.toString()).div(100);
    if (String(intent.currency).toUpperCase() !== 'USD' || !amount || !amount.eq(asked)) {
      throw this.failure('amount_mismatch', null, `intent is ${String(intent.amount)} ${String(intent.currency)}`);
    }
    return { referenceId: attemptOf(intent) ?? input.authority, cardPan: null, alreadyVerified: false };
  }

  async quoteFee(_input: FeeQuoteInput): Promise<FeeQuote> {
    throw this.failure('invalid_request', null, 'Airwallex has no fee API; price this gateway with a manual fee');
  }

  private async intent(credentials: GatewayCredentials, id: string): Promise<Intent> {
    const keys = this.keysOf(credentials);
    const path = `/api/v1/pa/payment_intents/${encodeURIComponent(id)}`;
    for (let attempt = 1; ; attempt++) {
      try {
        return (await this.call(keys, 'GET', path)) as Intent;
      } catch (e) {
        if (!(e instanceof GatewayFailure) || e.reason !== 'unavailable' || attempt >= READ_ATTEMPTS) throw e;
      }
    }
  }

  private keysOf(credentials: GatewayCredentials): Keys {
    if (!credentials.merchantId || !credentials.secretKey) {
      throw this.failure('merchant_rejected', null, 'no client id and API key are stored for this gateway');
    }
    const cacheKey = createHash('sha256').update(credentials.merchantId).update('\0').update(credentials.secretKey).digest('hex');
    return { clientId: credentials.merchantId, apiKey: credentials.secretKey, cacheKey };
  }

  /** A bearer token for these keys: the cached one while it has a minute left, else a fresh login. */
  private async token(keys: Keys): Promise<string> {
    const cached = this.tokens.get(keys.cacheKey);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.now()) return cached.value;

    const data = await this.send('POST', '/api/v1/authentication/login', {
      'x-client-id': keys.clientId,
      'x-api-key': keys.apiKey,
    });
    if (typeof data['token'] !== 'string' || !data['token']) throw this.failure('unexpected', null, 'login answer has no token');
    const parsed = typeof data['expires_at'] === 'string' ? Date.parse(data['expires_at']) : NaN;
    const expiresAt = Number.isFinite(parsed) ? parsed : this.now() + TOKEN_FALLBACK_MS;
    this.forgetExpired();
    this.tokens.set(keys.cacheKey, { value: data['token'], expiresAt });
    return data['token'];
  }

  private forgetExpired(): void {
    const now = this.now();
    for (const [key, token] of this.tokens) if (token.expiresAt <= now) this.tokens.delete(key);
  }

  /** An authenticated call. A cached token refused with 401 is dropped and the call made once more on a fresh one. */
  private async call(keys: Keys, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const hadToken = this.tokens.has(keys.cacheKey);
    try {
      return await this.send(method, path, { authorization: `Bearer ${await this.token(keys)}` }, body);
    } catch (e) {
      if (!hadToken || !(e instanceof GatewayFailure) || e.reason !== 'merchant_rejected') throw e;
      this.tokens.delete(keys.cacheKey);
      return this.send(method, path, { authorization: `Bearer ${await this.token(keys)}` }, body);
    }
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string>,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.hosts.api}${path}`, {
        method,
        headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw this.failure('unavailable', null, `${path}: ${(e as Error).name || 'network error'}`);
    }
    if (response.status >= 500) throw this.failure('unavailable', null, `${path}: HTTP ${response.status}`);
    let parsed: Record<string, unknown>;
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      throw this.failure('unexpected', null, `${path}: HTTP ${response.status} with no JSON body`);
    }
    if (response.ok && parsed && typeof parsed === 'object') return parsed;
    // The error's code only: its message may echo a key it rejected.
    const code = typeof parsed?.['code'] === 'string' ? parsed['code'] : null;
    throw this.failure(reasonOf(response.status), code, `${path}: HTTP ${response.status}`);
  }

  private failure(reason: GatewayFailureReason, code: string | null, detail: string): GatewayFailure {
    return new GatewayFailure(this.name, reason, code, detail);
  }
}

type Keys = { clientId: string; apiKey: string; cacheKey: string };

function reasonOf(status: number): GatewayFailureReason {
  if (status === 401 || status === 403) return 'merchant_rejected';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'authority_invalid';
  if (status >= 400) return 'invalid_request';
  return 'unexpected';
}

function headerOf(input: WebhookInput, name: string): string | undefined {
  const value = input.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function attemptOf(intent: Intent): string | null {
  const attempt = intent.latest_payment_attempt as { id?: unknown } | null | undefined;
  return typeof attempt?.id === 'string' && attempt.id ? attempt.id : null;
}

function decimalOf(value: unknown): Prisma.Decimal | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  try {
    const d = new Prisma.Decimal(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}
