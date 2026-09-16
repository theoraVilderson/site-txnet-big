import { createHmac, timingSafeEqual } from 'node:crypto';

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

export type OxaPayOptions = {
  /** Asks for sandbox invoices (`sandbox: true`) — per environment, never per tenant. The host is the same. */
  sandbox: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const HOST = 'https://api.oxapay.com/v1';

/** The payment types a merchant key signs. A payout is signed by another key and is not ours. */
const PAYMENT_TYPES = new Set(['invoice', 'white_label', 'static_address', 'payment_link', 'donation']);

/** Neither money nor a final word. `underpaid`: see the class comment. */
const PENDING = new Set(['new', 'waiting', 'paying', 'underpaid', 'refunding']);
const PAID = new Set(['paid', 'manual_accept']);

type Invoice = { track_id?: unknown; status?: unknown; type?: unknown; amount?: unknown; currency?: unknown; txs?: unknown };

/** Attempts for a read that is safe to repeat. `request` gets none. */
const READ_ATTEMPTS = 2;

/**
 * OxaPay (F-104-i, D-32): a hosted invoice, settled by callback. Checked
 * against docs.oxapay.com 2026-09-16.
 *
 * - `request` opens `POST /payment/invoice` in USD (header `merchant_api_key`,
 *   the gateway's `merchantId` slot) and is never retried. `track_id` is the
 *   authority; `callback_url` is the gateway's webhook door, per invoice.
 * - A callback carries `HMAC` = HMAC-SHA512 hex over the **raw** body, keyed by
 *   the **merchant key** — so this provider's `webhookSignedWith` is
 *   `merchantId` (`provider-fields.ts`), and no separate secret is stored.
 *   OxaPay counts a delivery only when the body is `ok`.
 * - `paid` and `manual_accept` are paid; `refunded` reversed.
 * - **`underpaid` settles nothing** — a deviation from "mapped as F-104-h's".
 *   The docs give a callback's `amount`, `value` and each transaction's
 *   `value` without saying which is the USD that arrived, and a guessed figure
 *   is a guessed credit (F-104-d). It stays pending: the payer may complete
 *   it, our clock expires the row, and a person reads the invoice.
 * - `expired` fails only an invoice with no transaction: one that received
 *   something may hold money, and a closed row cannot be credited.
 * - `inquire` and `verify` read `GET /payment/{track_id}`. No fee API.
 */
export class OxaPayProvider implements PaymentProvider {
  readonly name = PaymentProviderName.oxapay;
  readonly chargeCurrency = 'USD';
  readonly chargeDecimals = 2;
  readonly verifyWindowSec = null;
  readonly settlement = 'webhook' as const;

  private readonly sandbox: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OxaPayOptions) {
    this.sandbox = options.sandbox;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async request(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    const key = this.keyOf(input.credentials);
    if (!input.webhookUrl) throw this.failure('invalid_request', null, 'no callback url to give the invoice');
    const cents = input.amountMinor;
    if (cents <= BigInt(0) || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw this.failure('invalid_request', null, 'amount is not a positive whole number of cents');
    }
    const orderId = paymentIdInUrl(input.callbackUrl);

    const data = await this.call(key, 'POST', '/payment/invoice', {
      amount: Number(new Prisma.Decimal(cents.toString()).div(100).toString()),
      currency: 'USD',
      callback_url: input.webhookUrl,
      return_url: input.callbackUrl,
      ...(orderId ? { order_id: orderId } : {}),
      description: input.description,
      sandbox: this.sandbox,
    });
    if (typeof data['track_id'] !== 'string' && typeof data['track_id'] !== 'number') {
      throw this.failure('unexpected', null, 'invoice answer has no track_id');
    }
    if (typeof data['payment_url'] !== 'string') throw this.failure('unexpected', null, 'invoice answer has no payment_url');
    return { authority: String(data['track_id']), redirectUrl: data['payment_url'] };
  }

  verifyWebhook(input: WebhookInput): WebhookEvent {
    const header = input.headers['hmac'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) throw new WebhookSignatureInvalid(this.name, 'no HMAC header');
    const expected = createHmac('sha512', input.secret).update(input.rawBody).digest();
    const given = Buffer.from(signature, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new WebhookSignatureInvalid(this.name, 'signature does not match');
    }

    let body: Invoice;
    try {
      body = JSON.parse(input.rawBody.toString('utf8')) as Invoice;
    } catch {
      // Signed, and still not JSON: nothing here to act on.
      return { kind: 'ignored', type: 'unparseable' };
    }
    const type = String(body.type ?? '').toLowerCase();
    const status = String(body.status ?? '').toLowerCase();
    if (!PAYMENT_TYPES.has(type) || body.track_id === undefined || body.track_id === null) {
      return { kind: 'ignored', type: `${type}:${status}` };
    }
    const authority = String(body.track_id);

    if (PAID.has(status)) return { kind: 'paid', authority, referenceId: referenceOf(body) ?? authority };
    if (status === 'refunded') return { kind: 'reversed', authority };
    if (status === 'expired') return hasTransactions(body) ? { kind: 'pending', authority } : { kind: 'failed', authority };
    if (PENDING.has(status)) return { kind: 'pending', authority };
    return { kind: 'ignored', type: `${type}:${status}` };
  }

  async inquire(input: PaymentInquiryInput): Promise<PaymentInquiryResult> {
    const invoice = await this.invoice(input.credentials, input.authority);
    const status = String(invoice.status ?? '').toLowerCase();
    if (PAID.has(status)) return { status: 'verified' };
    if (status === 'refunded') return { status: 'reversed' };
    if (status === 'expired' && !hasTransactions(invoice)) return { status: 'failed' };
    return { status: 'in_bank' };
  }

  async verify(input: PaymentVerifyInput): Promise<PaymentVerifyResult> {
    const invoice = await this.invoice(input.credentials, input.authority);
    const status = String(invoice.status ?? '').toLowerCase();
    if (!PAID.has(status)) {
      throw this.failure(status === 'expired' && !hasTransactions(invoice) ? 'payment_failed' : 'unavailable', status || null, `invoice ${status}`);
    }
    const amount = decimalOf(invoice.amount);
    const asked = new Prisma.Decimal(input.amountMinor.toString()).div(100);
    if (String(invoice.currency).toUpperCase() !== 'USD' || !amount || !amount.eq(asked)) {
      throw this.failure('amount_mismatch', null, `invoice is ${String(invoice.amount)} ${String(invoice.currency)}`);
    }
    return { referenceId: referenceOf(invoice) ?? input.authority, cardPan: null, alreadyVerified: false };
  }

  async quoteFee(_input: FeeQuoteInput): Promise<FeeQuote> {
    throw this.failure('invalid_request', null, 'OxaPay has no fee API; price this gateway with a manual fee');
  }

  private async invoice(credentials: GatewayCredentials, trackId: string): Promise<Invoice> {
    const key = this.keyOf(credentials);
    const path = `/payment/${encodeURIComponent(trackId)}`;
    for (let attempt = 1; ; attempt++) {
      try {
        return (await this.call(key, 'GET', path)) as Invoice;
      } catch (e) {
        if (!(e instanceof GatewayFailure) || e.reason !== 'unavailable' || attempt >= READ_ATTEMPTS) throw e;
      }
    }
  }

  private keyOf(credentials: GatewayCredentials): string {
    if (!credentials.merchantId) throw this.failure('merchant_rejected', null, 'no merchant key is stored for this gateway');
    return credentials.merchantId;
  }

  private async call(key: string, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${HOST}${path}`, {
        method,
        headers: { merchant_api_key: key, 'content-type': 'application/json', accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw this.failure('unavailable', null, `${path}: ${(e as Error).name || 'network error'}`);
    }
    if (response.status >= 500) throw this.failure('unavailable', null, `${path}: HTTP ${response.status}`);
    let parsed: { data?: unknown; error?: { key?: unknown } | null };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
      throw this.failure('unexpected', null, `${path}: HTTP ${response.status} with no JSON body`);
    }
    if (response.ok && !parsed.error && parsed.data && typeof parsed.data === 'object') {
      return parsed.data as Record<string, unknown>;
    }
    // The error's key only: its message may echo the key it rejected.
    const code = typeof parsed.error?.key === 'string' ? parsed.error.key : null;
    throw this.failure(reasonOf(response.status, code), code, `${path}: HTTP ${response.status}`);
  }

  private failure(reason: GatewayFailureReason, code: string | null, detail: string): GatewayFailure {
    return new GatewayFailure(this.name, reason, code, detail);
  }
}

function reasonOf(status: number, code: string | null): GatewayFailureReason {
  if (status === 401 || status === 403 || (code ?? '').includes('api_key')) return 'merchant_rejected';
  if (status === 429) return 'rate_limited';
  if (status === 404 || (code ?? '').includes('track_id')) return 'authority_invalid';
  if (status >= 400) return 'invalid_request';
  return 'unexpected';
}

function transactionsOf(invoice: Invoice): Array<Record<string, unknown>> {
  return Array.isArray(invoice.txs) ? (invoice.txs as Array<Record<string, unknown>>) : [];
}

function hasTransactions(invoice: Invoice): boolean {
  return transactionsOf(invoice).length > 0;
}

/** The first transaction's hash — the receipt a person can look up on chain. */
function referenceOf(invoice: Invoice): string | null {
  const hash = transactionsOf(invoice)[0]?.['tx_hash'];
  return typeof hash === 'string' && hash ? hash : null;
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
