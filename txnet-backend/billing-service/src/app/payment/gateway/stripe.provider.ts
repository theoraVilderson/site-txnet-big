import { PaymentProviderName } from '@prisma/client';
import Stripe from 'stripe';

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

export type StripeOptions = {
  /** Tests pass a fake; the SDK's own fetch client carries it. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** Attempts for a call that is safe to repeat. `request` gets none. */
const READ_RETRIES = 2;

/** The session is what the browser comes back naming; the callback reads `authority` in any spelling. */
const SESSION_PLACEHOLDER = 'authority={CHECKOUT_SESSION_ID}';

/**
 * Stripe Checkout (F-104-g, D-32): a hosted payment page, settled by webhook.
 *
 * The first `webhook` driver, and so the one that proves F-104-b's door. The
 * official SDK does the wire and the signing: `constructEvent` checks a post
 * against the gateway's webhook secret before a field of it is read, and a
 * Stripe client is built **per call** from the gateway's own secret key, so no
 * key outlives the call it was read for (billing invariant 8) or reaches
 * another gateway.
 *
 * - `request` opens a Checkout Session for the amount in cents and is never
 *   retried: a timeout that reached Stripe already minted a session. The
 *   session id is the payment's authority, and the success and cancel URLs
 *   both return to the callback naming it.
 * - A result arrives signed: `checkout.session.completed` is paid only when
 *   the session is `paid`; `checkout.session.expired` fails the payment.
 *   **`payment_intent.payment_failed` is ignored**: inside Checkout a declined
 *   card is retried on the same page, so closing the payment on the first
 *   decline would leave the attempt that succeeds nothing to credit. A payment
 *   that is never paid fails when its session expires.
 * - `inquire` and `verify` retrieve the session, for the sweep (F-092-l) and
 *   the browser return. Stripe has no step that confirms a payment, so
 *   `verify` checks the session is paid at the amount asked.
 * - **No fee API.** A Stripe gateway is priced by its manual fee; an automatic
 *   one is refused rather than quoted as zero.
 *
 * A failure names the Stripe error type and code, never its message: Stripe
 * echoes a rejected key (masked, but a key's tail is still a key's tail).
 */
export class StripeProvider implements PaymentProvider {
  readonly name = PaymentProviderName.stripe;
  readonly chargeCurrency = 'USD';
  readonly chargeDecimals = 2;
  readonly verifyWindowSec = null;
  readonly settlement = 'webhook' as const;

  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: StripeOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async request(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    const client = this.client(input.credentials, 0);
    const returnUrl = `${input.callbackUrl}${input.callbackUrl.includes('?') ? '&' : '?'}${SESSION_PLACEHOLDER}`;
    const cents = Number(input.amountMinor);
    if (!Number.isSafeInteger(cents) || cents <= 0) throw this.failure('invalid_request', null, 'amount is not a positive whole number of cents');

    const session = await this.call('request', () =>
      client.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          { quantity: 1, price_data: { currency: 'usd', unit_amount: cents, product_data: { name: input.description || 'Top-up' } } },
        ],
        success_url: returnUrl,
        cancel_url: returnUrl,
        ...(input.email ? { customer_email: input.email } : {}),
      }),
    );
    if (!session.url) throw this.failure('unexpected', null, 'session has no hosted URL');
    return { authority: session.id, redirectUrl: session.url };
  }

  verifyWebhook(input: WebhookInput): WebhookEvent {
    const header = input.headers['stripe-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) throw new WebhookSignatureInvalid(this.name, 'no stripe-signature header');

    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(input.rawBody, signature, input.secret);
    } catch (e) {
      // The SDK's message names the rule that failed, never the secret.
      throw new WebhookSignatureInvalid(this.name, (e as Error).name);
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        return this.isPaid(s)
          ? { kind: 'paid', authority: s.id, referenceId: this.referenceOf(s) }
          : { kind: 'pending', authority: s.id };
      }
      case 'checkout.session.expired':
        return { kind: 'failed', authority: event.data.object.id };
      default:
        // Including `payment_intent.payment_failed`: see the class comment.
        return { kind: 'ignored', type: event.type };
    }
  }

  async inquire(input: PaymentInquiryInput): Promise<PaymentInquiryResult> {
    const s = await this.session(input.credentials, input.authority);
    if (this.isPaid(s)) return { status: 'verified' };
    return { status: s.status === 'expired' ? 'failed' : 'in_bank' };
  }

  async verify(input: PaymentVerifyInput): Promise<PaymentVerifyResult> {
    const s = await this.session(input.credentials, input.authority);
    if (!this.isPaid(s)) throw this.failure('payment_failed', s.payment_status, `session ${s.status}`);
    if (s.currency !== 'usd' || BigInt(s.amount_total ?? -1) !== input.amountMinor) {
      throw this.failure('amount_mismatch', null, `session paid ${s.amount_total} ${s.currency}`);
    }
    return { referenceId: this.referenceOf(s), cardPan: null, alreadyVerified: false };
  }

  async quoteFee(_input: FeeQuoteInput): Promise<FeeQuote> {
    throw this.failure('invalid_request', null, 'Stripe has no fee API; price this gateway with a manual fee');
  }

  private isPaid(s: Stripe.Checkout.Session): boolean {
    return s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required');
  }

  private referenceOf(s: Stripe.Checkout.Session): string {
    const intent = s.payment_intent;
    return (typeof intent === 'string' ? intent : intent?.id) ?? s.id;
  }

  private session(credentials: GatewayCredentials, id: string): Promise<Stripe.Checkout.Session> {
    const client = this.client(credentials, READ_RETRIES);
    return this.call('retrieve', () => client.checkout.sessions.retrieve(id));
  }

  private client(credentials: GatewayCredentials, maxNetworkRetries: number): Stripe {
    if (!credentials.secretKey) throw this.failure('merchant_rejected', null, 'no secret key is stored for this gateway');
    return new Stripe(credentials.secretKey, {
      maxNetworkRetries,
      timeout: this.timeoutMs,
      telemetry: false,
      ...(this.fetchImpl ? { httpClient: Stripe.createFetchHttpClient(this.fetchImpl) } : {}),
    });
  }

  private async call<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof GatewayFailure) throw e;
      const err = e as { type?: string; code?: string; statusCode?: number };
      const reason = this.reasonOf(err);
      throw this.failure(reason, err.code ?? null, `${what} failed: ${err.type ?? 'error'}${err.statusCode ? ` ${err.statusCode}` : ''}`);
    }
  }

  private reasonOf(err: { type?: string; code?: string; statusCode?: number }): GatewayFailureReason {
    if (err.statusCode === 401 || err.type === 'StripeAuthenticationError' || err.type === 'StripePermissionError') return 'merchant_rejected';
    if (err.type === 'StripeRateLimitError') return 'rate_limited';
    if (err.code === 'resource_missing') return 'authority_invalid';
    if (err.type === 'StripeInvalidRequestError' || err.type === 'StripeIdempotencyError') return 'invalid_request';
    if (err.type === 'StripeConnectionError' || err.type === 'StripeAPIError' || (err.statusCode ?? 0) >= 500) return 'unavailable';
    return 'unexpected';
  }

  private failure(reason: GatewayFailureReason, code: string | null, detail: string): GatewayFailure {
    return new GatewayFailure(this.name, reason, code, detail);
  }
}
