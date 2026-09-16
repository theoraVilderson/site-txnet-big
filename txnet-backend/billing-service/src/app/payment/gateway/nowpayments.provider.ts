import { createHmac, timingSafeEqual } from 'node:crypto';

import { PaymentProviderName, Prisma } from '@prisma/client';

import { paymentIdInUrl } from '../deposit/payment-callback-url';
import {
  FeeQuote,
  FeeQuoteInput,
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

export type NowPaymentsOptions = {
  /** `api-sandbox.nowpayments.io` instead of `api.nowpayments.io` — per environment, never per tenant. */
  sandbox: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const PRODUCTION_HOST = 'https://api.nowpayments.io/v1';
const SANDBOX_HOST = 'https://api-sandbox.nowpayments.io/v1';

/** Statuses that are neither money nor a final word (see the class comment for `failed` / `expired`). */
const PENDING = new Set(['waiting', 'confirming', 'confirmed', 'sending', 'failed', 'expired']);

type Ipn = {
  payment_id?: unknown;
  invoice_id?: unknown;
  payment_status?: unknown;
  price_amount?: unknown;
  price_currency?: unknown;
  pay_amount?: unknown;
  actually_paid?: unknown;
};

/**
 * NOWPayments (F-104-h, D-32): a hosted invoice, settled by IPN. Checked
 * against the API docs 2026-09-16.
 *
 * - `request` opens `POST /invoice` in USD and is never retried. The invoice id
 *   is the authority; the IPN url is told per invoice, so one NOWPayments
 *   account needs no dashboard setting per gateway.
 * - An IPN is signed `x-nowpayments-sig`: HMAC-SHA512 hex, keyed by the IPN
 *   secret, over the body re-serialized with its keys sorted recursively — the
 *   docs' own Node example. It carries a **payment** of the invoice.
 * - `finished` is paid; `partially_paid` is paid for what arrived (F-104-d),
 *   valued in the invoice's USD as `price_amount × actually_paid / pay_amount`.
 *   `refunded` is reversed (F-092-ae).
 * - **`failed` and `expired` are pending, not failed** — a deviation from the
 *   row, found in the docs: one invoice can hold several payments (the payer
 *   switches coin, or pays again into the same address), so the end of one
 *   says nothing about the invoice. Our own clock expires an unpaid row, and a
 *   later `finished` still credits an expired one (ADR-0046 decision 1).
 * - **`inquire` cannot see the invoice.** Finding a payment by invoice id is the
 *   payment list, which needs a JWT from the account's email and password —
 *   credentials a gateway does not hold. It answers `in_bank` without a call:
 *   the IPN settles, NOWPayments repeats it, and nothing is closed on a guess.
 * - No fee API; an automatic fee is refused, as Stripe's.
 */
export class NowPaymentsProvider implements PaymentProvider {
  readonly name = PaymentProviderName.nowpayments;
  readonly chargeCurrency = 'USD';
  readonly chargeDecimals = 2;
  readonly verifyWindowSec = null;
  readonly settlement = 'webhook' as const;

  private readonly host: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: NowPaymentsOptions) {
    this.host = options.sandbox ? SANDBOX_HOST : PRODUCTION_HOST;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async request(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    const apiKey = input.credentials.secretKey;
    if (!apiKey) throw this.failure('merchant_rejected', null, 'no API key is stored for this gateway');
    if (!input.webhookUrl) throw this.failure('invalid_request', null, 'no IPN url to give the invoice');
    const cents = input.amountMinor;
    if (cents <= BigInt(0) || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw this.failure('invalid_request', null, 'amount is not a positive whole number of cents');
    }
    const orderId = paymentIdInUrl(input.callbackUrl);

    const data = await this.post(apiKey, '/invoice', {
      price_amount: Number(new Prisma.Decimal(cents.toString()).div(100).toString()),
      price_currency: 'usd',
      ...(orderId ? { order_id: orderId } : {}),
      order_description: input.description,
      ipn_callback_url: input.webhookUrl,
      // No placeholder for the invoice id exists: the return names the payment
      // by `?p=`, and the callback shows a webhook payment by it.
      success_url: input.callbackUrl,
      cancel_url: input.callbackUrl,
    });
    const id = data['id'];
    const url = data['invoice_url'];
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof url !== 'string') {
      throw this.failure('unexpected', null, 'invoice answer has no id or invoice_url');
    }
    return { authority: String(id), redirectUrl: url };
  }

  verifyWebhook(input: WebhookInput): WebhookEvent {
    const header = input.headers['x-nowpayments-sig'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) throw new WebhookSignatureInvalid(this.name, 'no x-nowpayments-sig header');

    let body: Ipn;
    try {
      body = JSON.parse(input.rawBody.toString('utf8')) as Ipn;
    } catch {
      throw new WebhookSignatureInvalid(this.name, 'body is not JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WebhookSignatureInvalid(this.name, 'body is not an object');
    const expected = createHmac('sha512', input.secret).update(JSON.stringify(sortedKeys(body))).digest();
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new WebhookSignatureInvalid(this.name, 'signature does not match');
    }

    const status = String(body.payment_status ?? '');
    if (body.invoice_id === null || body.invoice_id === undefined) return { kind: 'ignored', type: `payment:${status}` };
    const authority = String(body.invoice_id);
    const referenceId = String(body.payment_id ?? authority);

    switch (status) {
      case 'finished': {
        const received = this.receivedCents(body);
        const asked = this.askedCents(body);
        return received !== null && asked !== null && received > asked
          ? { kind: 'paid', authority, referenceId, received: { amountMinor: received, currency: 'USD' } }
          : { kind: 'paid', authority, referenceId };
      }
      case 'partially_paid': {
        const received = this.receivedCents(body);
        const asked = this.askedCents(body);
        if (received === null || asked === null) return { kind: 'pending', authority };
        const amountMinor = received < asked ? received : asked;
        return { kind: 'paid', authority, referenceId, received: { amountMinor, currency: 'USD' } };
      }
      case 'refunded':
        return { kind: 'reversed', authority };
      default:
        return PENDING.has(status) ? { kind: 'pending', authority } : { kind: 'ignored', type: `payment:${status}` };
    }
  }

  async inquire(_input: PaymentInquiryInput): Promise<PaymentInquiryResult> {
    return { status: 'in_bank' };
  }

  async verify(_input: PaymentVerifyInput): Promise<PaymentVerifyResult> {
    throw this.failure('unavailable', null, 'an invoice cannot be read with the API key alone; the IPN settles it');
  }

  async quoteFee(_input: FeeQuoteInput): Promise<FeeQuote> {
    throw this.failure('invalid_request', null, 'NOWPayments has no fee API; price this gateway with a manual fee');
  }

  /** What arrived, in USD cents floored — `null` when the IPN cannot say (not USD, nothing asked). */
  private receivedCents(body: Ipn): bigint | null {
    const price = decimalOf(body.price_amount);
    const pay = decimalOf(body.pay_amount);
    const paid = decimalOf(body.actually_paid);
    if (String(body.price_currency).toLowerCase() !== 'usd' || !price || !pay || !paid || pay.lte(0) || paid.lt(0)) return null;
    return BigInt(price.mul(paid).div(pay).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN).toFixed(0));
  }

  private askedCents(body: Ipn): bigint | null {
    const price = decimalOf(body.price_amount);
    return price ? BigInt(price.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0)) : null;
  }

  private async post(apiKey: string, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.host}${path}`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
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
    if (response.ok) return parsed;
    // The code only: a message may echo the key it rejected.
    const code = typeof parsed['code'] === 'string' ? parsed['code'] : null;
    throw this.failure(reasonOf(response.status), code, `${path}: HTTP ${response.status}`);
  }

  private failure(reason: GatewayFailureReason, code: string | null, detail: string): GatewayFailure {
    return new GatewayFailure(this.name, reason, code, detail);
  }
}

function reasonOf(status: number): GatewayFailureReason {
  if (status === 401 || status === 403) return 'merchant_rejected';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'authority_invalid';
  if (status >= 400) return 'invalid_request';
  return 'unexpected';
}

/** A JSON number or numeric string, exactly as sent. */
function decimalOf(value: unknown): Prisma.Decimal | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  try {
    const d = new Prisma.Decimal(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** The body with every object's keys sorted, recursively — what NOWPayments signs. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((out, key) => {
        out[key] = sortedKeys(obj[key]);
        return out;
      }, {});
  }
  return value;
}
