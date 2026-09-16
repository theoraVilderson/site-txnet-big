import { createHmac } from 'node:crypto';

import { AirwallexProvider } from './airwallex.provider';
import { GatewayFailure, WebhookSignatureInvalid } from './payment-provider';

/**
 * The Airwallex driver (F-104-j, D-32) — a PaymentIntent on the hosted payment
 * page, settled by webhook.
 *
 * Checked against airwallex.com/docs on 2026-09-16: `POST
 * /api/v1/authentication/login` with `x-client-id` + `x-api-key` answers a
 * 30-minute bearer token; a webhook carries `x-timestamp` (ms) and
 * `x-signature` = HMAC-SHA256 hex over timestamp + **raw** body, keyed by the
 * notification URL's secret. The fixed vector below was computed by Python's
 * `hmac` over the bytes as sent.
 *
 * What has to hold, and would fail silently:
 *  - **the token is cached per credential pair** — another gateway's keys
 *    never get it, and a rotated key logs in again;
 *  - **timestamp + raw bytes are what is signed**, and an old timestamp is a replay;
 *  - **only `payment_intent.succeeded` is money**, `cancelled` a failure, and
 *    `payment_failed` nothing: the hosted page lets the payer try again;
 *  - the sandbox hosts under `PAYMENT_GATEWAY_SANDBOX`.
 */

const CLIENT_ID = 'awx_client_id';
const API_KEY = 'awx_api_key_do_not_log';
const SECRET = 'whsec_airwallex_do_not_log';
const credentials = { merchantId: CLIENT_ID, secretKey: API_KEY };

const NOW = 1789552800000;
const DOCS_BODY =
  '{"id":"evt_hkdmr5hq5gmbs9wwa9n","name":"payment_intent.succeeded","account_id":"acct_7PpJqGpoPcGQwKoEbpqZ0Q","data":{"object":{"id":"int_hkdmr5hq5gmbs9wwa9n1","amount":12.5,"currency":"USD","captured_amount":12.5,"status":"SUCCEEDED","merchant_order_id":"77777777-7777-4777-8777-777777777777","request_id":"req-1","latest_payment_attempt":{"id":"att_hkdm1"}}},"created_at":"2026-09-16T10:00:00+0000","version":"2024-09-27"}';
const DOCS_SIGNATURE = 'd2186eb5fe4d56928593ed4952ad8a17688b2ea69f51df33c8b51c9acf25027c';

function event(name: string, object: Record<string, unknown> = {}, at = NOW, secret = SECRET) {
  const parsed = JSON.parse(DOCS_BODY);
  const body = JSON.stringify({ ...parsed, name, data: { object: { ...parsed.data.object, ...object } } });
  const signature = createHmac('sha256', secret).update(`${at}${body}`).digest('hex');
  return { rawBody: Buffer.from(body), headers: { 'x-timestamp': String(at), 'x-signature': signature }, secret: SECRET };
}

type Reply = { status?: number; body: unknown } | Error;
type Call = { url: string; method: string; body: string; headers: Record<string, string> };

function airwallex(replies: Reply[] = [], options: { sandbox?: boolean; now?: number } = {}) {
  const calls: Call[] = [];
  let now = options.now ?? NOW;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: String(init.body ?? ''), headers: init.headers as Record<string, string> });
    const reply = replies.shift();
    if (!reply) throw new Error('no reply queued');
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const provider = new AirwallexProvider({ sandbox: options.sandbox ?? false, fetchImpl, now: () => now });
  return { provider, calls, advance: (ms: number) => (now += ms) };
}

/** Airwallex's own `expires_at` spelling: `+0000`, not `Z`. */
const in30Minutes = new Date(NOW + 30 * 60_000).toISOString().replace(/\.\d{3}Z$/, '+0000');
const login = (token = 'tok-1', expiresAt = in30Minutes) => ({ status: 201, body: { token, expires_at: expiresAt } });
const intent = (object: Record<string, unknown>) => ({ body: { id: 'int_hkdmr5hq5gmbs9wwa9n1', currency: 'USD', amount: 12.5, ...object } });
const created = intent({ client_secret: 'cs_secret', status: 'REQUIRES_PAYMENT_METHOD' });

const REQUEST = {
  credentials,
  amountMinor: BigInt(1250),
  callbackUrl: 'https://panel.example.com/api/billing/deposit/callback?p=77777777-7777-4777-8777-777777777777',
  webhookUrl: 'https://panel.example.com/api/billing/deposit/webhook/airwallex/55555555-5555-4555-8555-555555555555',
  description: 'Top-up 7777',
};

describe('AirwallexProvider.verifyWebhook — the signature', () => {
  const { provider } = airwallex();

  it('accepts a succeeded event signed over timestamp + its raw bytes', () => {
    const input = { rawBody: Buffer.from(DOCS_BODY), headers: { 'x-timestamp': String(NOW), 'x-signature': DOCS_SIGNATURE }, secret: SECRET };

    expect(provider.verifyWebhook(input)).toEqual({ kind: 'paid', authority: 'int_hkdmr5hq5gmbs9wwa9n1', referenceId: 'att_hkdm1' });
  });

  it('refuses a re-serialized body, another timestamp, a wrong secret and missing headers', () => {
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(DOCS_BODY), null, 1));
    const bad = [
      { rawBody: reformatted, headers: { 'x-timestamp': String(NOW), 'x-signature': DOCS_SIGNATURE }, secret: SECRET },
      { rawBody: Buffer.from(DOCS_BODY), headers: { 'x-timestamp': String(NOW + 1), 'x-signature': DOCS_SIGNATURE }, secret: SECRET },
      event('payment_intent.succeeded', {}, NOW, 'another_secret'),
      { rawBody: Buffer.from(DOCS_BODY), headers: { 'x-timestamp': String(NOW) }, secret: SECRET },
      { rawBody: Buffer.from(DOCS_BODY), headers: { 'x-signature': DOCS_SIGNATURE }, secret: SECRET },
    ];
    for (const input of bad) expect(() => provider.verifyWebhook(input)).toThrow(WebhookSignatureInvalid);
  });

  it('refuses a correctly signed post older or newer than the tolerance — a replay', () => {
    expect(() => provider.verifyWebhook(event('payment_intent.succeeded', {}, NOW - 6 * 60_000))).toThrow(WebhookSignatureInvalid);
    expect(() => provider.verifyWebhook(event('payment_intent.succeeded', {}, NOW + 6 * 60_000))).toThrow(WebhookSignatureInvalid);
    expect(provider.verifyWebhook(event('payment_intent.succeeded', {}, NOW - 4 * 60_000))).toMatchObject({ kind: 'paid' });
  });
});

describe('AirwallexProvider.verifyWebhook — what a signed event means', () => {
  const { provider } = airwallex();
  const authority = 'int_hkdmr5hq5gmbs9wwa9n1';

  it('names the intent when the event carries no attempt', () => {
    expect(provider.verifyWebhook(event('payment_intent.succeeded', { latest_payment_attempt: null }))).toEqual({
      kind: 'paid',
      authority,
      referenceId: authority,
    });
  });

  it('fails a cancelled intent', () => {
    expect(provider.verifyWebhook(event('payment_intent.cancelled', { status: 'CANCELLED' }))).toEqual({ kind: 'failed', authority });
  });

  it.each([
    'payment_intent.created',
    'payment_intent.requires_payment_method',
    'payment_intent.requires_customer_action',
    'payment_intent.requires_capture',
    'payment_intent.pending',
    'payment_intent.pending_review',
    'payment_intent.payment_failed',
    'payment_intent.updated',
  ])('holds %s as pending', (name) => {
    expect(provider.verifyWebhook(event(name))).toEqual({ kind: 'pending', authority });
  });

  it('ignores a refund, another resource and an unknown event', () => {
    expect(provider.verifyWebhook(event('refund.settled'))).toEqual({ kind: 'ignored', type: 'refund.settled' });
    expect(provider.verifyWebhook(event('payout.transfer.paid'))).toEqual({ kind: 'ignored', type: 'payout.transfer.paid' });
    expect(provider.verifyWebhook(event('payment_intent.succeeded', { id: null }))).toEqual({ kind: 'ignored', type: 'payment_intent.succeeded' });
  });
});

describe('AirwallexProvider — the access token', () => {
  it('logs in with the client id and API key, and reuses the token until shortly before it expires', async () => {
    const { provider, calls, advance } = airwallex([login('tok-1'), created, created, login('tok-2'), created]);

    await provider.request(REQUEST);
    await provider.request(REQUEST);
    advance(29 * 60_000 + 30_000);
    await provider.request(REQUEST);

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.airwallex.com/api/v1/authentication/login',
      'https://api.airwallex.com/api/v1/pa/payment_intents/create',
      'https://api.airwallex.com/api/v1/pa/payment_intents/create',
      'https://api.airwallex.com/api/v1/authentication/login',
      'https://api.airwallex.com/api/v1/pa/payment_intents/create',
    ]);
    expect(calls[0].headers).toMatchObject({ 'x-client-id': CLIENT_ID, 'x-api-key': API_KEY });
    expect(calls[1].headers['authorization']).toBe('Bearer tok-1');
    expect(calls[4].headers['authorization']).toBe('Bearer tok-2');
  });

  it("never hands one gateway's token to another gateway's keys", async () => {
    const { provider, calls } = airwallex([login('tok-a'), created, login('tok-b'), created]);

    await provider.request(REQUEST);
    await provider.request({ ...REQUEST, credentials: { merchantId: CLIENT_ID, secretKey: 'another_api_key' } });

    expect(calls[2].url).toContain('/authentication/login');
    expect(calls[3].headers['authorization']).toBe('Bearer tok-b');
  });

  it('logs in again once when a cached token is refused, keeping the same request_id', async () => {
    const { provider, calls } = airwallex([login('tok-1'), created, { status: 401, body: { code: 'unauthorized' } }, login('tok-2'), created]);

    await provider.request(REQUEST);
    await provider.request(REQUEST);

    expect(calls[3].url).toContain('/authentication/login');
    expect(calls[4].headers['authorization']).toBe('Bearer tok-2');
    expect(JSON.parse(calls[4].body).request_id).toBe(JSON.parse(calls[2].body).request_id);
  });

  it('refuses rejected keys as merchant_rejected and names neither key', async () => {
    const { provider } = airwallex([{ status: 401, body: { code: 'credentials_invalid', message: `bad ${API_KEY}` } }]);

    const error = await provider.request(REQUEST).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayFailure);
    expect(error).toMatchObject({ reason: 'merchant_rejected', providerCode: 'credentials_invalid' });
    expect(String((error as Error).message)).not.toContain(API_KEY);
  });

  it('refuses without a client id or API key, calling nothing', async () => {
    const { provider, calls } = airwallex();

    await expect(provider.request({ ...REQUEST, credentials: { merchantId: CLIENT_ID } })).rejects.toMatchObject({ reason: 'merchant_rejected' });
    await expect(provider.request({ ...REQUEST, credentials: { secretKey: API_KEY } })).rejects.toMatchObject({ reason: 'merchant_rejected' });
    expect(calls).toEqual([]);
  });
});

describe('AirwallexProvider — calls', () => {
  it('creates a USD intent and sends the payer to the hosted page with it', async () => {
    const { provider, calls } = airwallex([login(), created]);

    const result = await provider.request(REQUEST);

    expect(result.authority).toBe('int_hkdmr5hq5gmbs9wwa9n1');
    const url = new URL(result.redirectUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://checkout.airwallex.com/');
    const [route, query] = url.hash.split('?');
    expect(route).toBe('#/standalone/checkout');
    const params = new URLSearchParams(query);
    expect(Object.fromEntries(params)).toEqual({
      intent_id: 'int_hkdmr5hq5gmbs9wwa9n1',
      client_secret: 'cs_secret',
      currency: 'USD',
      successUrl: REQUEST.callbackUrl,
      failUrl: REQUEST.callbackUrl,
    });

    const body = JSON.parse(calls[1].body);
    expect(body).toMatchObject({
      amount: 12.5,
      currency: 'USD',
      merchant_order_id: '77777777-7777-4777-8777-777777777777',
      return_url: REQUEST.callbackUrl,
      descriptor: 'Top-up 7777',
    });
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses the sandbox hosts under PAYMENT_GATEWAY_SANDBOX', async () => {
    const { provider, calls } = airwallex([login(), created], { sandbox: true });

    const { redirectUrl } = await provider.request(REQUEST);

    expect(calls[0].url).toBe('https://api.sandbox.airwallex.com/api/v1/authentication/login');
    expect(calls[1].url).toBe('https://api.sandbox.airwallex.com/api/v1/pa/payment_intents/create');
    expect(redirectUrl.startsWith('https://checkout.sandbox.airwallex.com/#/standalone/checkout?')).toBe(true);
  });

  it('never retries a create that met silence', async () => {
    const { provider, calls } = airwallex([login(), { status: 503, body: {} }]);

    await expect(provider.request(REQUEST)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(calls).toHaveLength(2);
  });

  it('inquires the intent: succeeded is verified, cancelled failed, anything else still at the bank', async () => {
    const { provider, calls } = airwallex([
      login(),
      intent({ status: 'SUCCEEDED' }),
      intent({ status: 'CANCELLED' }),
      intent({ status: 'REQUIRES_CUSTOMER_ACTION' }),
    ]);
    const ask = () => provider.inquire({ credentials, authority: 'int_hkdmr5hq5gmbs9wwa9n1' });

    await expect(ask()).resolves.toEqual({ status: 'verified' });
    await expect(ask()).resolves.toEqual({ status: 'failed' });
    await expect(ask()).resolves.toEqual({ status: 'in_bank' });
    expect(calls[1]).toMatchObject({ url: 'https://api.airwallex.com/api/v1/pa/payment_intents/int_hkdmr5hq5gmbs9wwa9n1', method: 'GET' });
  });

  it('verifies a succeeded intent at the amount asked, and refuses another amount or an unpaid one', async () => {
    const { provider } = airwallex([
      login(),
      intent({ status: 'SUCCEEDED', latest_payment_attempt: { id: 'att_1' } }),
      intent({ status: 'SUCCEEDED', amount: 10 }),
      intent({ status: 'CANCELLED' }),
    ]);
    const verify = () => provider.verify({ credentials, authority: 'int_hkdmr5hq5gmbs9wwa9n1', amountMinor: BigInt(1250) });

    await expect(verify()).resolves.toEqual({ referenceId: 'att_1', cardPan: null, alreadyVerified: false });
    await expect(verify()).rejects.toMatchObject({ reason: 'amount_mismatch' });
    await expect(verify()).rejects.toMatchObject({ reason: 'payment_failed' });
  });
});
