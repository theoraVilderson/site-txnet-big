import Stripe from 'stripe';

import { GatewayFailure, WebhookSignatureInvalid } from './payment-provider';
import { StripeProvider } from './stripe.provider';

/**
 * The Stripe driver (F-104-g, D-32) — the first that settles by webhook, and
 * so the one that proves F-104-b's door against a real provider's signing.
 *
 * Done without a live account: every body below is the shape Stripe's docs
 * give for a Checkout Session and its events, and every signature is made by
 * the official SDK's `generateTestHeaderString` — the same code
 * `constructEvent` checks against. What has to hold, and would fail silently:
 *
 *  - **only a signed post is read.** A wrong secret, a tampered byte, a missing
 *    or stale header is `WebhookSignatureInvalid` — the door's 401;
 *  - **`paid` only for a session Stripe says is paid.** A completed session
 *    still `unpaid` (a delayed method) is pending, not money;
 *  - **a failed card attempt does not close the payment.** Inside Checkout the
 *    payer can retry on the same page, so `payment_intent.payment_failed` is
 *    ignored; only `checkout.session.expired` fails the row. Closing it on the
 *    first decline would leave the retry that succeeds with nothing to credit;
 *  - **`request` is never retried** — a timeout that reached Stripe already
 *    minted a session — and a secret key never appears in a failure;
 *  - amounts cross in cents, `USD`.
 */

const SECRET_KEY = 'sk_test_51Hq_do_not_log_me';
const WEBHOOK_SECRET = 'whsec_test_signing_secret';
const credentials = { secretKey: SECRET_KEY };

/** A Checkout Session as `GET /v1/checkout/sessions/:id` answers it (trimmed to the fields read). */
function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_a1b2c3',
    object: 'checkout.session',
    amount_total: 1250,
    currency: 'usd',
    mode: 'payment',
    payment_intent: 'pi_3MtwBwLkdIwHu7ix28a3tqPa',
    payment_status: 'paid',
    status: 'complete',
    url: null,
    ...overrides,
  };
}

function event(type: string, object: Record<string, unknown>) {
  return JSON.stringify({ id: 'evt_1NG8Du2eZvKYlo2CUI79vXWy', object: 'event', api_version: '2024-06-20', created: 1686089970, type, data: { object } });
}

function signed(payload: string, secret = WEBHOOK_SECRET) {
  return { 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret }) };
}

type Reply = { status?: number; body: unknown } | Error;

function stripe(replies: Reply[] = []) {
  const calls: Array<{ url: string; method: string; body: string; auth: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({ url: String(url), method: init.method ?? 'GET', body: String(init.body ?? ''), auth: headers.get('authorization') ?? '' });
    const reply = replies.shift();
    if (!reply) throw new Error('no reply queued');
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json', 'request-id': 'req_1' } });
  }) as unknown as typeof fetch;
  return { provider: new StripeProvider({ fetchImpl }), calls };
}

async function failure(run: () => Promise<unknown>): Promise<GatewayFailure> {
  try {
    await run();
  } catch (e) {
    if (e instanceof GatewayFailure) return e;
    throw e;
  }
  throw new Error('expected a GatewayFailure');
}

describe('StripeProvider — what it is', () => {
  it('charges USD in cents and settles by webhook', () => {
    const { provider } = stripe();
    expect([provider.name, provider.chargeCurrency, provider.chargeDecimals, provider.settlement]).toEqual(['stripe', 'USD', 2, 'webhook']);
    expect(provider.verifyWebhook).toBeTypeOf('function');
  });
});

describe('StripeProvider — request', () => {
  it('opens a hosted Checkout Session for the amount in cents and answers its id and URL', async () => {
    const { provider, calls } = stripe([{ body: session({ status: 'open', payment_status: 'unpaid', url: 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3' }) }]);

    const out = await provider.request({
      credentials,
      amountMinor: BigInt(1250),
      callbackUrl: 'https://panel.example.org/deposit/callback?p=pay-1',
      description: 'Wallet top-up',
      email: 'payer@example.org',
    });

    expect(out).toEqual({ authority: 'cs_test_a1b2c3', redirectUrl: 'https://checkout.stripe.com/c/pay/cs_test_a1b2c3' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(calls[0].auth).toBe(`Bearer ${SECRET_KEY}`);
    const form = new URLSearchParams(calls[0].body);
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('1250');
    expect(form.get('line_items[0][quantity]')).toBe('1');
    expect(form.get('customer_email')).toBe('payer@example.org');
    // The browser comes back to the callback naming the session, which is the payment's authority.
    expect(form.get('success_url')).toBe('https://panel.example.org/deposit/callback?p=pay-1&authority={CHECKOUT_SESSION_ID}');
    expect(form.get('cancel_url')).toBe('https://panel.example.org/deposit/callback?p=pay-1&authority={CHECKOUT_SESSION_ID}');
  });

  it('is never retried, and a failure never carries the secret key', async () => {
    const { provider, calls } = stripe([{ status: 500, body: { error: { type: 'api_error', message: 'boom' } } }, { body: session() }]);

    const e = await failure(() => provider.request({ credentials, amountMinor: BigInt(100), callbackUrl: 'https://x.example/cb?p=1', description: 'Top-up' }));

    expect(e.reason).toBe('unavailable');
    expect(calls).toHaveLength(1);
    expect(e.message).not.toContain(SECRET_KEY);
  });

  it('maps a rejected key to merchant_rejected, and refuses without calling when no key is stored', async () => {
    const { provider, calls } = stripe([{ status: 401, body: { error: { type: 'invalid_request_error', message: `Invalid API Key provided: ${SECRET_KEY}` } } }]);

    const rejected = await failure(() => provider.request({ credentials, amountMinor: BigInt(100), callbackUrl: 'https://x.example/cb', description: 'Top-up' }));
    expect(rejected.reason).toBe('merchant_rejected');
    expect(rejected.message).not.toContain(SECRET_KEY);

    const none = await failure(() => provider.request({ credentials: {}, amountMinor: BigInt(100), callbackUrl: 'https://x.example/cb', description: 'Top-up' }));
    expect(none.reason).toBe('merchant_rejected');
    expect(calls).toHaveLength(1);
  });
});

describe('StripeProvider — verifyWebhook', () => {
  it('reads a completed, paid session as paid, with the PaymentIntent as the reference', async () => {
    const { provider } = stripe();
    const payload = event('checkout.session.completed', session());

    await expect(Promise.resolve(provider.verifyWebhook({ rawBody: Buffer.from(payload), headers: signed(payload), secret: WEBHOOK_SECRET }))).resolves.toEqual({
      kind: 'paid',
      authority: 'cs_test_a1b2c3',
      referenceId: 'pi_3MtwBwLkdIwHu7ix28a3tqPa',
    });
  });

  it('reads a completed session that is not paid yet as pending, and an expired one as failed', async () => {
    const { provider } = stripe();
    const unpaid = event('checkout.session.completed', session({ payment_status: 'unpaid' }));
    const expired = event('checkout.session.expired', session({ status: 'expired', payment_status: 'unpaid', payment_intent: null }));

    await expect(Promise.resolve(provider.verifyWebhook({ rawBody: Buffer.from(unpaid), headers: signed(unpaid), secret: WEBHOOK_SECRET }))).resolves.toEqual({ kind: 'pending', authority: 'cs_test_a1b2c3' });
    await expect(Promise.resolve(provider.verifyWebhook({ rawBody: Buffer.from(expired), headers: signed(expired), secret: WEBHOOK_SECRET }))).resolves.toEqual({ kind: 'failed', authority: 'cs_test_a1b2c3' });
  });

  it('settles a delayed method: async_payment_succeeded pays, async_payment_failed fails (F-104-y)', async () => {
    const { provider } = stripe();
    const paid = event('checkout.session.async_payment_succeeded', session());
    const failed = event('checkout.session.async_payment_failed', session({ payment_status: 'unpaid', payment_intent: null }));
    const stillUnpaid = event('checkout.session.async_payment_succeeded', session({ payment_status: 'unpaid' }));

    await expect(Promise.resolve(provider.verifyWebhook({ rawBody: Buffer.from(paid), headers: signed(paid), secret: WEBHOOK_SECRET }))).resolves.toEqual({
      kind: 'paid',
      authority: 'cs_test_a1b2c3',
      referenceId: 'pi_3MtwBwLkdIwHu7ix28a3tqPa',
    });
    await expect(Promise.resolve(provider.verifyWebhook({ rawBody: Buffer.from(failed), headers: signed(failed), secret: WEBHOOK_SECRET }))).resolves.toEqual({ kind: 'failed', authority: 'cs_test_a1b2c3' });
    await expect(Promise.resolve(provider.verifyWebhook({ rawBody: Buffer.from(stillUnpaid), headers: signed(stillUnpaid), secret: WEBHOOK_SECRET }))).resolves.toEqual({ kind: 'pending', authority: 'cs_test_a1b2c3' });
  });

  it('ignores a declined card attempt — the payer may still pay on the same page — and any other event', async () => {
    const { provider } = stripe();
    const declined = event('payment_intent.payment_failed', { id: 'pi_3MtwBwLkdIwHu7ix28a3tqPa', object: 'payment_intent', status: 'requires_payment_method' });
    const other = event('customer.created', { id: 'cus_1', object: 'customer' });

    await expect(Promise.resolve(provider.verifyWebhook({ rawBody: Buffer.from(declined), headers: signed(declined), secret: WEBHOOK_SECRET }))).resolves.toEqual({ kind: 'ignored', type: 'payment_intent.payment_failed' });
    await expect(Promise.resolve(provider.verifyWebhook({ rawBody: Buffer.from(other), headers: signed(other), secret: WEBHOOK_SECRET }))).resolves.toEqual({ kind: 'ignored', type: 'customer.created' });
  });

  it('refuses a post signed with another secret, a tampered body, and a missing header', async () => {
    const { provider } = stripe();
    const payload = event('checkout.session.completed', session());

    const attempts = [
      { rawBody: Buffer.from(payload), headers: signed(payload, 'whsec_somebody_else') },
      { rawBody: Buffer.from(payload.replace('1250', '9999')), headers: signed(payload) },
      { rawBody: Buffer.from(payload), headers: {} },
    ];
    for (const attempt of attempts) {
      await expect(Promise.resolve().then(() => provider.verifyWebhook({ ...attempt, secret: WEBHOOK_SECRET }))).rejects.toBeInstanceOf(WebhookSignatureInvalid);
    }
  });
});

describe('StripeProvider — inquire and verify (the sweep, F-092-l)', () => {
  it('answers where a session stands', async () => {
    const { provider, calls } = stripe([
      { body: session() },
      { body: session({ status: 'open', payment_status: 'unpaid' }) },
      { body: session({ status: 'complete', payment_status: 'unpaid' }) },
      { body: session({ status: 'expired', payment_status: 'unpaid' }) },
    ]);

    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await provider.inquire({ credentials, authority: 'cs_test_a1b2c3' })).status);

    expect(statuses).toEqual(['verified', 'in_bank', 'in_bank', 'failed']);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_test_a1b2c3');
  });

  it('verifies a paid session at the amount asked, and refuses another amount or an unpaid one', async () => {
    const { provider } = stripe([{ body: session() }, { body: session({ amount_total: 999 }) }, { body: session({ status: 'expired', payment_status: 'unpaid' }) }]);
    const input = { credentials, authority: 'cs_test_a1b2c3', amountMinor: BigInt(1250) };

    await expect(provider.verify(input)).resolves.toEqual({ referenceId: 'pi_3MtwBwLkdIwHu7ix28a3tqPa', cardPan: null, alreadyVerified: false });
    expect((await failure(() => provider.verify(input))).reason).toBe('amount_mismatch');
    expect((await failure(() => provider.verify(input))).reason).toBe('payment_failed');
  });

  it('answers an unknown session as authority_invalid', async () => {
    const { provider } = stripe([{ status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such checkout.session' } } }]);

    expect((await failure(() => provider.inquire({ credentials, authority: 'cs_test_nope' }))).reason).toBe('authority_invalid');
  });

  it('has no fee API: an automatic fee is refused, so the gateway must be priced by its manual fee', async () => {
    const { provider, calls } = stripe();

    expect((await failure(() => provider.quoteFee({ credentials, amountMinor: BigInt(1250) }))).reason).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });
});
