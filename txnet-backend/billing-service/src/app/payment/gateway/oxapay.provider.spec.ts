import { createHmac } from 'node:crypto';

import { GatewayFailure, WebhookSignatureInvalid } from './payment-provider';
import { OxaPayProvider } from './oxapay.provider';

/**
 * The OxaPay driver (F-104-i, D-32) — a hosted invoice, settled by callback.
 *
 * Checked against docs.oxapay.com on 2026-09-16: the callback carries header
 * `HMAC` = HMAC-SHA512 hex over the **raw** body, keyed by the merchant API key
 * (not a separate webhook secret); the invoice is `POST /v1/payment/invoice`
 * with header `merchant_api_key`, and `callback_url` is set per invoice. The
 * fixed vector below was computed by Python's `hmac` over the bytes as sent.
 *
 * What has to hold, and would fail silently:
 *  - **the raw bytes are what is signed** — a re-serialized body is not;
 *  - **`paid` / `manual_accept` are money**, `refunded` a reversal;
 *  - **`underpaid` settles nothing.** The docs do not say which figure is the
 *    USD that arrived, and a guessed figure is a guessed credit — it stays
 *    pending for our clock and a person;
 *  - **`expired` closes only an invoice nothing was sent to**;
 *  - `sandbox: true` on the invoice under `PAYMENT_GATEWAY_SANDBOX`.
 */

const MERCHANT_KEY = 'oxa_merchant_key_do_not_log';
const credentials = { merchantId: MERCHANT_KEY };

const DOCS_BODY =
  '{"track_id":"151811887","status":"Paid","type":"invoice","module_name":"OxaPay","amount":12.5,"value":12.5,"sent_value":12.5,"currency":"USD","order_id":"77777777-7777-4777-8777-777777777777","email":"customer@oxapay.com","note":"","fee_paid_by_payer":0,"under_paid_coverage":0,"description":"Top-up 7777","date":1738493900,"txs":[{"status":"confirmed","tx_hash":"0xabc","sent_amount":34,"received_amount":33.5,"value":12.5,"sent_value":12.5,"currency":"POL","network":"Polygon Network","sender_address":"x","address":"x","rate":0.36839,"confirmations":250,"auto_convert_amount":0,"auto_convert_currency":"USDT","date":1738494035}]}';
const DOCS_HMAC =
  'e4811373b2024afedc6761544543680ea55ee7c882281699f6530baf3a758231cf0b4613da23c34ae112d55660bfc6791de92fa9ec8bc33f7ebc006d45994f98';

function callback(overrides: Record<string, unknown> = {}, key = MERCHANT_KEY) {
  const body = JSON.stringify({ ...JSON.parse(DOCS_BODY), ...overrides });
  return { rawBody: Buffer.from(body), headers: { hmac: createHmac('sha512', key).update(body).digest('hex') }, secret: MERCHANT_KEY };
}

type Reply = { status?: number; body: unknown } | Error;

function oxapay(replies: Reply[] = [], sandbox = false) {
  const calls: Array<{ url: string; method: string; body: string; key: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, method: init.method ?? 'GET', body: String(init.body ?? ''), key: headers['merchant_api_key'] });
    const reply = replies.shift();
    if (!reply) throw new Error('no reply queued');
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { provider: new OxaPayProvider({ sandbox, fetchImpl }), calls };
}

const ok = (data: Record<string, unknown>) => ({ body: { data, message: 'Operation completed successfully!', error: null, status: 200, version: '1.0.0' } });

const REQUEST = {
  credentials,
  amountMinor: BigInt(1250),
  callbackUrl: 'https://panel.example.com/api/billing/deposit/callback?p=77777777-7777-4777-8777-777777777777',
  webhookUrl: 'https://panel.example.com/api/billing/deposit/webhook/oxapay/55555555-5555-4555-8555-555555555555',
  description: 'Top-up 7777',
};

describe('OxaPayProvider.verifyWebhook — the signature', () => {
  const { provider } = oxapay();

  it('accepts the docs’ Paid callback signed over its raw bytes with the merchant key', () => {
    const event = provider.verifyWebhook({ rawBody: Buffer.from(DOCS_BODY), headers: { hmac: DOCS_HMAC }, secret: MERCHANT_KEY });

    expect(event).toEqual({ kind: 'paid', authority: '151811887', referenceId: '0xabc' });
  });

  it('refuses a re-serialized body, a wrong key and a missing header', () => {
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(DOCS_BODY), null, 1));
    const bad = [
      { rawBody: reformatted, headers: { hmac: DOCS_HMAC }, secret: MERCHANT_KEY },
      callback({}, 'another_key'),
      { rawBody: Buffer.from(DOCS_BODY), headers: {}, secret: MERCHANT_KEY },
    ];
    for (const input of bad) expect(() => provider.verifyWebhook(input)).toThrow(WebhookSignatureInvalid);
  });
});

describe('OxaPayProvider.verifyWebhook — what a signed callback means', () => {
  const { provider } = oxapay();

  it('pays a manually accepted invoice, naming the track id when no transaction does', () => {
    expect(provider.verifyWebhook(callback({ status: 'Manual_Accept', txs: [] }))).toEqual({
      kind: 'paid',
      authority: '151811887',
      referenceId: '151811887',
    });
  });

  it.each(['New', 'Waiting', 'Paying', 'Underpaid', 'Refunding'])('holds %s as pending', (status) => {
    expect(provider.verifyWebhook(callback({ status }))).toEqual({ kind: 'pending', authority: '151811887' });
  });

  it('fails an expired invoice nothing was sent to, and holds one that received something', () => {
    expect(provider.verifyWebhook(callback({ status: 'Expired', txs: [] }))).toEqual({ kind: 'failed', authority: '151811887' });
    expect(provider.verifyWebhook(callback({ status: 'Expired' }))).toEqual({ kind: 'pending', authority: '151811887' });
  });

  it('reverses a refunded invoice, and ignores a payout or an unknown status', () => {
    expect(provider.verifyWebhook(callback({ status: 'Refunded' }))).toEqual({ kind: 'reversed', authority: '151811887' });
    expect(provider.verifyWebhook(callback({ type: 'payout', status: 'Confirmed' }))).toEqual({ kind: 'ignored', type: 'payout:confirmed' });
    expect(provider.verifyWebhook(callback({ status: 'Mystery' }))).toEqual({ kind: 'ignored', type: 'invoice:mystery' });
  });
});

describe('OxaPayProvider — calls', () => {
  it('opens a USD invoice with the callback and return urls, once', async () => {
    const { provider, calls } = oxapay([ok({ track_id: '151811887', payment_url: 'https://pay.oxapay.com/151811887', expired_at: 1738497500, date: 1738493900 })]);

    await expect(provider.request(REQUEST)).resolves.toEqual({ authority: '151811887', redirectUrl: 'https://pay.oxapay.com/151811887' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://api.oxapay.com/v1/payment/invoice', method: 'POST', key: MERCHANT_KEY });
    expect(JSON.parse(calls[0].body)).toEqual({
      amount: 12.5,
      currency: 'USD',
      callback_url: REQUEST.webhookUrl,
      return_url: REQUEST.callbackUrl,
      order_id: '77777777-7777-4777-8777-777777777777',
      description: 'Top-up 7777',
      sandbox: false,
    });
  });

  it('asks for a sandbox invoice under PAYMENT_GATEWAY_SANDBOX', async () => {
    const { provider, calls } = oxapay([ok({ track_id: '1', payment_url: 'https://pay.oxapay.com/1' })], true);

    await provider.request(REQUEST);

    expect(JSON.parse(calls[0].body)).toMatchObject({ sandbox: true });
  });

  it('never retries a request, and names no key in a failure', async () => {
    const down = oxapay([{ status: 503, body: {} }]);
    await expect(down.provider.request(REQUEST)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(down.calls).toHaveLength(1);

    const rejected = oxapay([
      { status: 401, body: { data: {}, message: '', error: { type: 'authentication', key: 'invalid_merchant_api_key', message: `bad key ${MERCHANT_KEY}` }, status: 401, version: '1.0.0' } },
    ]);
    const error = await rejected.provider.request(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayFailure);
    expect(error).toMatchObject({ reason: 'merchant_rejected', providerCode: 'invalid_merchant_api_key' });
    expect(String((error as Error).message)).not.toContain(MERCHANT_KEY);
  });

  it('refuses without a merchant key, and without a callback url to give', async () => {
    const { provider, calls } = oxapay();

    await expect(provider.request({ ...REQUEST, credentials: {} })).rejects.toMatchObject({ reason: 'merchant_rejected' });
    await expect(provider.request({ ...REQUEST, webhookUrl: undefined })).rejects.toMatchObject({ reason: 'invalid_request' });
    expect(calls).toEqual([]);
  });

  it('inquires the invoice: paid is verified, underpaid is still at the bank, an empty expiry failed, a refund reversed', async () => {
    const { provider, calls } = oxapay([
      ok({ track_id: '151811887', status: 'paid', amount: 12.5, currency: 'USD', txs: [] }),
      ok({ track_id: '151811887', status: 'underpaid', txs: [{ tx_hash: '0x1' }] }),
      ok({ track_id: '151811887', status: 'expired', txs: [] }),
      ok({ track_id: '151811887', status: 'refunded', txs: [{ tx_hash: '0x1' }] }),
    ]);
    const ask = () => provider.inquire({ credentials, authority: '151811887' });

    await expect(ask()).resolves.toEqual({ status: 'verified' });
    await expect(ask()).resolves.toEqual({ status: 'in_bank' });
    await expect(ask()).resolves.toEqual({ status: 'failed' });
    await expect(ask()).resolves.toEqual({ status: 'reversed' });
    expect(calls[0]).toMatchObject({ url: 'https://api.oxapay.com/v1/payment/151811887', method: 'GET', key: MERCHANT_KEY });
  });

  it('verifies a paid invoice at the amount asked, and refuses another amount', async () => {
    const { provider } = oxapay([
      ok({ track_id: '151811887', status: 'paid', amount: 12.5, currency: 'USD', txs: [{ tx_hash: '0xabc' }] }),
      ok({ track_id: '151811887', status: 'paid', amount: 10, currency: 'USD', txs: [] }),
    ]);
    const verify = () => provider.verify({ credentials, authority: '151811887', amountMinor: BigInt(1250) });

    await expect(verify()).resolves.toEqual({ referenceId: '0xabc', cardPan: null, alreadyVerified: false });
    await expect(verify()).rejects.toMatchObject({ reason: 'amount_mismatch' });
  });
});
