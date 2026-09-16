import type { PaymentProviderName } from '@prisma/client';

/**
 * The payment provider port (F-092-f) — what every gateway driver answers,
 * whatever it is called on the wire.
 *
 * A driver is transport and translation only. It holds no money rule: what to
 * charge comes from `pricing/gateway-pricing.ts`, whether to credit is
 * F-092-j's status-guarded transaction (ADR-0028), and where the merchant id
 * comes from is `gateway-merchant.ts`. A driver is handed the credentials for
 * one call and keeps none of them.
 *
 * Amounts cross this port in the **gateway currency's minor unit** — for
 * Zarinpal, whole rials — as a `bigint`, which is what `priceAtGateway` puts in
 * `chargedAmountMinor`. Converting base currency to that unit happens once,
 * with the rate snapshot, and never inside a driver.
 */

/** The secret half of a gateway, for exactly one call. Never logged (billing invariant 8). */
export type GatewayCredentials = { merchantId: string };

export type PaymentRequestInput = {
  credentials: GatewayCredentials;
  amountMinor: bigint;
  callbackUrl: string;
  description: string;
  mobile?: string;
  email?: string;
};

/** `authority` is `payment_transaction.gatewayTrackingCode` (ADR-0028). */
export type PaymentRequestResult = { authority: string; redirectUrl: string };

export type PaymentVerifyInput = {
  credentials: GatewayCredentials;
  authority: string;
  amountMinor: bigint;
  /**
   * Epoch ms after which no attempt is started and none is waited on; missing
   * means the driver's own attempts. A caller holding a browser sets it
   * (F-092-ab, ADR-0046 decision 2) — past it the answer is `unavailable`.
   */
  deadlineAt?: number;
};

/** `referenceId` is `payment_transaction.gatewayReferenceId`. */
export type PaymentVerifyResult = {
  referenceId: string;
  cardPan: string | null;
  /** The gateway had verified it before this call — still a success. */
  alreadyVerified: boolean;
};

export type PaymentInquiryInput = { credentials: GatewayCredentials; authority: string };

/** Where the gateway says a payment is. Only `verified` means the money is ours. */
export type PaymentInquiryStatus = 'verified' | 'paid' | 'in_bank' | 'failed' | 'reversed';

export type PaymentInquiryResult = { status: PaymentInquiryStatus };

/** A payment the gateway holds paid and unverified (F-092-ad). */
export type UnverifiedPayment = {
  authority: string;
  /** In the gateway currency's minor unit, as `chargedAmountMinor`. */
  amountMinor: bigint;
  /** The callback URL the payment was minted with — it names our payment id (`?p=`). */
  callbackUrl: string;
};

export type FeeQuoteInput = { credentials: GatewayCredentials; amountMinor: bigint };

/** The provider's fee for `amountMinor`, in the same unit. The caller converts it for `quotedFee`. */
export type FeeQuote = { feeMinor: bigint };

/**
 * How a driver learns a payment's result (D-32, ADR-0051 decision 5):
 * `return` — the payer's browser comes back and we verify (Zarinpal);
 * `webhook` — the provider's server posts it, signed, and the browser return
 * only shows it; `in_chat` — a messenger delivers it (F-104-k).
 */
export type SettlementMode = 'return' | 'webhook' | 'in_chat';

/** One webhook post, exactly as it arrived. `rawBody` is the signed bytes — never re-serialized JSON. */
export type WebhookInput = {
  rawBody: Buffer;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  secret: string;
};

/**
 * What a **signed** post says, in the port's terms. `authority` is the code the
 * payment row carries as `gatewayTrackingCode` (ADR-0028). An event this system
 * does not act on is `ignored`, and still answered 200 (ADR-0051 decision 4).
 */
export type WebhookEvent =
  | { kind: 'paid'; authority: string; referenceId: string }
  | { kind: 'failed'; authority: string }
  | { kind: 'pending'; authority: string }
  | { kind: 'ignored'; type: string };

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** The currency this gateway charges in, ISO 4217 — Zarinpal `IRR`. */
  readonly chargeCurrency: string;
  /** Decimal places of its minor unit — `priceAtGateway`'s `chargeDecimals`. */
  readonly chargeDecimals: number;
  /**
   * How long the gateway keeps a paid payment we have not verified before it
   * returns the money, in seconds — `null` when it does not (ADR-0046 decision 6).
   * A verifying payment on a windowed gateway is flagged for a person at half of
   * it. Required, so a new driver cannot forget to say.
   */
  readonly verifyWindowSec: number | null;
  /** How this gateway's result arrives. Required: the webhook door and the browser return both branch on it. */
  readonly settlement: SettlementMode;
  /**
   * Check a webhook's signature with `secret` and translate it (ADR-0051
   * decision 2). Throws `WebhookSignatureInvalid` on any doubt — before a
   * single field of the body is trusted. Required when `settlement` is
   * `webhook`; the registry refuses to boot a driver that omits it.
   */
  verifyWebhook?(input: WebhookInput): WebhookEvent | Promise<WebhookEvent>;
  /** Mint a payment intent. **Never retried**: every attempt mints a new authority. */
  request(input: PaymentRequestInput): Promise<PaymentRequestResult>;
  /** Confirm a payment. Retried on transport failure; "already verified" is success. */
  verify(input: PaymentVerifyInput): Promise<PaymentVerifyResult>;
  /** Ask where a payment is, without verifying it. Retried on transport failure. */
  inquire(input: PaymentInquiryInput): Promise<PaymentInquiryResult>;
  /**
   * The payments this merchant holds paid and unverified, when the gateway can
   * list them — how an authority whose write was lost is found again (F-092-ad,
   * ADR-0046 decision 4). Optional: a gateway without such a list omits it.
   * Retried on transport failure.
   */
  listUnverified?(input: { credentials: GatewayCredentials }): Promise<UnverifiedPayment[]>;
  /** The provider's own fee quote, for `feeCalculationMode = automatic`. Retried on transport failure. */
  quoteFee(input: FeeQuoteInput): Promise<FeeQuote>;
}

/**
 * Why a gateway call did not succeed, as a closed set every driver maps its own
 * codes onto.
 *
 * The route that first exposes one maps the reason to an i18n key (C-01), the
 * same rule the ledger and the calculator follow; a driver never carries a
 * sentence meant for a user, which is where legacy kept its Persian strings.
 */
export type GatewayFailureReason =
  /** The request was malformed — a caller bug. */
  | 'invalid_request'
  /** The merchant id is wrong, inactive or suspended — the gateway's owner must act. */
  | 'merchant_rejected'
  /** The gateway is throttling this merchant. Not retried: retrying is what it counts. */
  | 'rate_limited'
  /** The amount verified is not the amount requested. */
  | 'amount_mismatch'
  /** The user did not pay, or the bank declined. */
  | 'payment_failed'
  /** The authority is unknown, or belongs to another merchant. */
  | 'authority_invalid'
  /** No answer: timeout, network error or 5xx, after any retries. Outcome unknown. */
  | 'unavailable'
  /** An answer this driver has no mapping for. */
  | 'unexpected';

export class GatewayFailure extends Error {
  constructor(
    readonly provider: PaymentProviderName,
    readonly reason: GatewayFailureReason,
    /** The gateway's own code, when it answered one — for the log, never for a user. */
    readonly providerCode: string | null,
    detail: string,
  ) {
    super(`${provider}: ${reason}${providerCode ? ` (${providerCode})` : ''} — ${detail}`);
    this.name = 'GatewayFailure';
  }
}

export class ProviderNotSupported extends Error {
  constructor(readonly provider: string) {
    super(`no payment provider driver is registered for '${provider}'`);
    this.name = 'ProviderNotSupported';
  }
}

/** A webhook whose signature did not hold. The door answers 401 and reads nothing more. */
export class WebhookSignatureInvalid extends Error {
  constructor(
    readonly provider: PaymentProviderName,
    detail: string,
  ) {
    super(`${provider}: webhook signature invalid — ${detail}`);
    this.name = 'WebhookSignatureInvalid';
  }
}
