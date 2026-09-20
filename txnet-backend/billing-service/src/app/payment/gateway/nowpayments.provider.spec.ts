import { createHmac } from 'node:crypto';

import { GatewayFailure, WebhookSignatureInvalid } from './payment-provider';
import { NowPaymentsProvider } from './nowpayments.provider';

/**
 * The NOWPayments driver (F-104-h, D-32) — a hosted invoice, settled by IPN.
 *
 * Checked against the API docs on 2026-09-16 (Postman collection 7907941): the
 * IPN header is `x-nowpayments-sig`, HMAC-SHA512 in hex over the body with its
 * keys sorted **recursively** and no whitespace, keyed by the IPN secret. The
 * one fixed vector below was computed by Python's `json.dumps(sort_keys=True,
 * separators=(',', ':'))` — the docs' own Python example, a separate
 * implementation from the driver's — over the docs' webhook example.
 *
 * What has to hold, and would fail silently:
 *  - **only a signed post is read**, whatever order its keys arrived in;
 *  - **a partial payment is paid for what arrived** (F-104-d), valued in the
 *    invoice's USD — never the crypto amount, never the asked price;
 *  - **`failed` / `expired` close nothing.** One invoice can carry several
 *    payments (the payer switches coin), and a closed row would refuse the one
 *    that succeeds; our own clock ends an unpaid row, and credit still accepts it;
 *  - **`inquire` cannot see an invoice** with the API key alone (the list needs a
 *    login JWT), so it answers `unknown` and calls nothing — it never credits
 *    or closes on a guess, and never claims the payer is at the bank (F-104-v).
 */

const API_KEY = 'np_api_key_do_not_log';
const IPN_SECRET = 'ipn_secret_do_not_log';
const credentials = { secretKey: API_KEY };

/** The docs' webhook example, as the docs order it — unsorted, with spaces. */
const DOCS_BODY =
  '{"payment_id": 123456789, "parent_payment_id": 987654321, "invoice_id": 4522625843, "payment_status": "finished", "pay_address": "address", "payin_extra_id": null, "price_amount": 12.5, "price_currency": "usd", "pay_amount": 15, "actually_paid": 15, "actually_paid_at_fiat": 0, "pay_currency": "trx", "order_id": null, "order_description": null, "purchase_id": "123456789", "outcome_amount": 14.8106, "outcome_currency": "trx", "payment_extra_ids": null, "fee": {"currency": "btc", "depositFee": 0.09853637216235617, "withdrawalFee": 0, "serviceFee": 0}}';
const DOCS_SIG =
  '0286209387288f3be53062afa247f4962d3d58388de1ba512f21aeb1b06b68b5af958d8ae47aa191a827e53d19b2ef04c8ee4a527517060b6f7cf07e821b9892';

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** An IPN with `overrides`, signed as NOWPayments signs it. */
function ipn(overrides: Record<string, unknown> = {}, secret = IPN_SECRET) {
  const body = JSON.stringify({ ...JSON.parse(DOCS_BODY), ...overrides });
  const sig = createHmac('sha512', secret).update(JSON.stringify(sorted(JSON.parse(body)))).digest('hex');
  return { rawBody: Buffer.from(body), headers: { 'x-nowpayments-sig': sig }, secret: IPN_SECRET };
}

type Reply = { status?: number; body: unknown } | Error;

function nowpayments(replies: Reply[] = [], sandbox = false) {
  const calls: Array<{ url: string; method: string; body: string; apiKey: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, method: init.method ?? 'GET', body: String(init.body ?? ''), apiKey: headers['x-api-key'] });
    const reply = replies.shift();
    if (!reply) throw new Error('no reply queued');
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { provider: new NowPaymentsProvider({ sandbox, fetchImpl }), calls };
}

const REQUEST = {
  credentials,
  amountMinor: BigInt(1250),
  callbackUrl: 'https://panel.example.com/api/billing/deposit/callback?p=77777777-7777-4777-8777-777777777777',
  webhookUrl: 'https://panel.example.com/api/billing/deposit/webhook/nowpayments/55555555-5555-4555-8555-555555555555',
  description: 'Top-up 7777',
};

describe('NowPaymentsProvider.verifyWebhook — the signature', () => {
  const { provider } = nowpayments();

  it('accepts the docs’ example signed over its recursively key-sorted JSON', () => {
    const event = provider.verifyWebhook({ rawBody: Buffer.from(DOCS_BODY), headers: { 'x-nowpayments-sig': DOCS_SIG }, secret: IPN_SECRET });

    expect(event).toEqual({ kind: 'paid', authority: '4522625843', referenceId: '123456789' });
  });

  it('refuses a tampered byte, a wrong secret and a missing header', () => {
    const tampered = Buffer.from(DOCS_BODY.replace('"actually_paid": 15', '"actually_paid": 16'));
    const bad = [
      { rawBody: tampered, headers: { 'x-nowpayments-sig': DOCS_SIG }, secret: IPN_SECRET },
      { ...ipn({}, 'another_secret') },
      { rawBody: Buffer.from(DOCS_BODY), headers: {}, secret: IPN_SECRET },
      { rawBody: Buffer.from('not json'), headers: { 'x-nowpayments-sig': DOCS_SIG }, secret: IPN_SECRET },
    ];
    for (const input of bad) expect(() => provider.verifyWebhook(input)).toThrow(WebhookSignatureInvalid);
  });
});

describe('NowPaymentsProvider.verifyWebhook — what a signed IPN means', () => {
  const { provider } = nowpayments();

  it('pays a partial payment for what arrived, in the invoice’s USD cents (F-104-d)', () => {
    // Half of the 15 TRX asked arrived, on a 12.50 USD invoice.
    expect(provider.verifyWebhook(ipn({ payment_status: 'partially_paid', actually_paid: 7.5 }))).toEqual({
      kind: 'paid',
      authority: '4522625843',
      referenceId: '123456789',
      received: { amountMinor: BigInt(625), currency: 'USD' },
    });
  });

  it('reports an overpayment, and a finished payment a rounding short of the price as exact', () => {
    expect(provider.verifyWebhook(ipn({ actually_paid: 16.5 }))).toMatchObject({ received: { amountMinor: BigInt(1375), currency: 'USD' } });
    expect(provider.verifyWebhook(ipn({ actually_paid: 14.99 }))).not.toHaveProperty('received');
  });

  it('never settles a partial payment it cannot value', () => {
    expect(provider.verifyWebhook(ipn({ payment_status: 'partially_paid', pay_amount: 0 }))).toEqual({ kind: 'pending', authority: '4522625843' });
    expect(provider.verifyWebhook(ipn({ payment_status: 'partially_paid', price_currency: 'eur' }))).toEqual({ kind: 'pending', authority: '4522625843' });
  });

  it.each(['waiting', 'confirming', 'confirmed', 'sending', 'failed', 'expired'])('holds %s as pending — nothing closes', (status) => {
    expect(provider.verifyWebhook(ipn({ payment_status: status }))).toEqual({ kind: 'pending', authority: '4522625843' });
  });

  it('reverses a refunded payment (F-092-ae)', () => {
    expect(provider.verifyWebhook(ipn({ payment_status: 'refunded' }))).toEqual({ kind: 'reversed', authority: '4522625843' });
  });

  it('ignores a payment no invoice of ours made, and a status it does not know', () => {
    expect(provider.verifyWebhook(ipn({ invoice_id: null }))).toEqual({ kind: 'ignored', type: 'payment:finished' });
    expect(provider.verifyWebhook(ipn({ payment_status: 'wrong_asset_confirmed' }))).toEqual({ kind: 'ignored', type: 'payment:wrong_asset_confirmed' });
  });
});

describe('NowPaymentsProvider — calls', () => {
  it('opens a USD invoice on the hosted page, with the IPN url and the return url, once', async () => {
    const { provider, calls } = nowpayments([{ body: { id: '4522625843', invoice_url: 'https://nowpayments.io/payment/?iid=4522625843' } }]);

    await expect(provider.request(REQUEST)).resolves.toEqual({
      authority: '4522625843',
      redirectUrl: 'https://nowpayments.io/payment/?iid=4522625843',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://api.nowpayments.io/v1/invoice', method: 'POST', apiKey: API_KEY });
    expect(JSON.parse(calls[0].body)).toEqual({
      price_amount: 12.5,
      price_currency: 'usd',
      order_id: '77777777-7777-4777-8777-777777777777',
      order_description: 'Top-up 7777',
      ipn_callback_url: REQUEST.webhookUrl,
      success_url: REQUEST.callbackUrl,
      cancel_url: REQUEST.callbackUrl,
    });
  });

  it('goes to the sandbox host under PAYMENT_GATEWAY_SANDBOX', async () => {
    const { provider, calls } = nowpayments([{ body: { id: '1', invoice_url: 'https://sandbox.nowpayments.io/payment/?iid=1' } }], true);

    await provider.request(REQUEST);

    expect(calls[0].url).toBe('https://api-sandbox.nowpayments.io/v1/invoice');
  });

  it('never retries a request, and names no key in a failure', async () => {
    const down = nowpayments([{ status: 502, body: {} }]);
    await expect(down.provider.request(REQUEST)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(down.calls).toHaveLength(1);

    const rejected = nowpayments([{ status: 403, body: { statusCode: 403, code: 'INVALID_API_KEY', message: `Invalid api key ${API_KEY}` } }]);
    const error = await rejected.provider.request(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayFailure);
    expect(error).toMatchObject({ reason: 'merchant_rejected', providerCode: 'INVALID_API_KEY' });
    expect(String((error as Error).message)).not.toContain(API_KEY);
  });

  it('refuses without an API key, and without a webhook url to be told', async () => {
    const { provider, calls } = nowpayments();

    await expect(provider.request({ ...REQUEST, credentials: {} })).rejects.toMatchObject({ reason: 'merchant_rejected' });
    await expect(provider.request({ ...REQUEST, webhookUrl: undefined })).rejects.toMatchObject({ reason: 'invalid_request' });
    expect(calls).toEqual([]);
  });

  // F-104-v: `unknown`, not `in_bank`. `in_bank` is a payer still at the bank —
  // an answer that kept the row on the verify ladder, out of the expiry sweep's
  // reach and beyond a person's reject, for ever.
  it('inquires nothing it cannot see: unknown, and verify is unavailable, with no call made', async () => {
    const { provider, calls } = nowpayments();

    await expect(provider.inquire({ credentials, authority: '4522625843' })).resolves.toEqual({ status: 'unknown' });
    await expect(provider.verify({ credentials, authority: '4522625843', amountMinor: BigInt(1250) })).rejects.toMatchObject({ reason: 'unavailable' });
    expect(calls).toEqual([]);
  });
});
