import { PaymentProviderName } from '@prisma/client';

import {
  FeeQuote,
  FeeQuoteInput,
  GatewayCredentials,
  GatewayFailure,
  GatewayFailureReason,
  PaymentInquiryInput,
  PaymentInquiryResult,
  PaymentInquiryStatus,
  PaymentProvider,
  PaymentRequestInput,
  PaymentRequestResult,
  PaymentVerifyInput,
  PaymentVerifyResult,
  UnverifiedPayment,
} from './payment-provider';

/**
 * Zarinpal, API v4 (F-092-f). Ported from legacy `providers/zarinpal.ts`, minus
 * its three bugs — see `zarinpal.provider.spec.ts`:
 *
 *  - `verify` read `101` (already verified) as a failure;
 *  - every call was retried, `request` included, and so was a definite refusal;
 *  - the fee quote always went to the production host, sandbox or not.
 *
 * Amounts are sent as `IRR`. Legacy sent `IRT` and multiplied by ten in the
 * browser; a rial minor unit is what `priceAtGateway` produces
 * (`chargeDecimals: 0`), so nothing here converts.
 */

export type ZarinpalOptions = {
  /** `sandbox.zarinpal.com` instead of `payment.zarinpal.com` — per environment, never per tenant. */
  sandbox: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The clock a deadline is read against. Tests pass a fake one. */
  now?: () => number;
  timeoutMs?: number;
};

/** Codes that are an answer. Anything else from the gateway is `unexpected`. */
const FAILURE_BY_CODE: Record<string, GatewayFailureReason> = {
  '-9': 'invalid_request',
  '-10': 'merchant_rejected',
  '-11': 'merchant_rejected',
  '-12': 'rate_limited',
  '-15': 'merchant_rejected',
  '-16': 'merchant_rejected',
  '-30': 'merchant_rejected',
  '-31': 'merchant_rejected',
  '-32': 'invalid_request',
  '-33': 'invalid_request',
  '-34': 'invalid_request',
  '-35': 'invalid_request',
  '-40': 'invalid_request',
  '-50': 'amount_mismatch',
  '-51': 'payment_failed',
  '-53': 'authority_invalid',
  '-54': 'authority_invalid',
};

const INQUIRY_STATUS: Record<string, PaymentInquiryStatus> = {
  VERIFIED: 'verified',
  PAID: 'paid',
  IN_BANK: 'in_bank',
  FAILED: 'failed',
  REVERSED: 'reversed',
};

/** Attempts for a call that is safe to repeat. Delays between them, in ms. */
const RETRY_DELAYS_MS = [500, 1500];

type ZarinpalBody = {
  data?: Record<string, unknown> | unknown[];
  errors?: { code?: number | string; message?: string; validations?: unknown } | unknown[];
};

/**
 * Zarinpal's own words for a refusal — `message` and, for `-9`, which field
 * failed validation — for the log line `toHttp` writes; never for a user. A
 * validation message may quote the value it refused, so the merchant id is
 * redacted wherever it appears (billing invariant 8).
 */
function refusalDetail(errors: { message?: unknown; validations?: unknown }, merchantId: string): string {
  const parts: string[] = [];
  if (typeof errors.message === 'string' && errors.message) parts.push(errors.message);
  const validations = Array.isArray(errors.validations) ? errors.validations : errors.validations ? [errors.validations] : [];
  for (const entry of validations) {
    if (!entry || typeof entry !== 'object') continue;
    for (const [field, text] of Object.entries(entry as Record<string, unknown>)) {
      parts.push(`${field}: ${Array.isArray(text) ? text.join(' ') : String(text)}`);
    }
  }
  if (parts.length === 0) return '';
  const detail = parts.join('; ').slice(0, 500);
  return `: ${merchantId ? detail.split(merchantId).join('[redacted]') : detail}`;
}

/** No answer reached us. The only failure a retry can change. */
class TransportFailure extends Error {}

export class ZarinpalProvider implements PaymentProvider {
  readonly name = PaymentProviderName.zarinpal;
  readonly chargeCurrency = 'IRR';
  readonly chargeDecimals = 0;

  private readonly host: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: ZarinpalOptions) {
    this.host = `https://${options.sandbox ? 'sandbox' : 'payment'}.zarinpal.com/pg`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async request(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    const data = await this.once('request', input.credentials, {
      amount: this.wireAmount(input.amountMinor),
      currency: this.chargeCurrency,
      callback_url: input.callbackUrl,
      description: input.description,
      metadata: { mobile: input.mobile, email: input.email },
    });
    this.requireCode(data, [100]);
    const authority = String(data['authority'] ?? '');
    if (!authority) throw this.failure('unexpected', null, 'request answered 100 with no authority');
    return { authority, redirectUrl: `${this.host}/StartPay/${authority}` };
  }

  async verify(input: PaymentVerifyInput): Promise<PaymentVerifyResult> {
    const data = await this.retried(
      'verify',
      input.credentials,
      { amount: this.wireAmount(input.amountMinor), authority: input.authority },
      input.deadlineAt,
    );
    const code = this.requireCode(data, [100, 101]);
    return {
      referenceId: String(data['ref_id']),
      cardPan: typeof data['card_pan'] === 'string' ? data['card_pan'] : null,
      alreadyVerified: code === 101,
    };
  }

  async inquire(input: PaymentInquiryInput): Promise<PaymentInquiryResult> {
    const data = await this.retried('inquiry', input.credentials, { authority: input.authority });
    this.requireCode(data, [100]);
    const status = INQUIRY_STATUS[String(data['status'])];
    if (!status) throw this.failure('unexpected', null, `inquiry status '${String(data['status'])}'`);
    return { status };
  }

  /**
   * `unVerified.json`: the last 100 payments Zarinpal holds paid and not yet
   * verified by us. An entry missing a field or carrying a non-integer amount is
   * skipped — a list we half-read must not attach a guessed authority.
   */
  async listUnverified(input: { credentials: GatewayCredentials }): Promise<UnverifiedPayment[]> {
    const data = await this.retried('unVerified', input.credentials, {});
    this.requireCode(data, [100]);
    const entries = Array.isArray(data['authorities']) ? (data['authorities'] as unknown[]) : [];
    const list: UnverifiedPayment[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const { authority, amount, callback_url: callbackUrl } = entry as Record<string, unknown>;
      if (typeof authority !== 'string' || !authority) continue;
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) continue;
      if (typeof callbackUrl !== 'string' || !callbackUrl) continue;
      list.push({ authority, amountMinor: BigInt(amount), callbackUrl });
    }
    return list;
  }

  async quoteFee(input: FeeQuoteInput): Promise<FeeQuote> {
    const data = await this.retried('feeCalculation', input.credentials, {
      amount: this.wireAmount(input.amountMinor),
      currency: this.chargeCurrency,
    });
    this.requireCode(data, [100]);
    const suggested = data['suggested_amount'];
    if (typeof suggested !== 'number' || !Number.isSafeInteger(suggested)) {
      throw this.failure('unexpected', null, 'feeCalculation answered no suggested_amount');
    }
    const fee = BigInt(suggested) - input.amountMinor;
    if (fee < BigInt(0)) throw this.failure('unexpected', null, 'feeCalculation suggested less than the amount');
    return { feeMinor: fee };
  }

  /** One attempt. A transport failure is `unavailable`: whether the gateway acted is unknown. */
  private async once(
    method: string,
    credentials: GatewayCredentials,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.post(method, credentials, body);
    } catch (err) {
      if (err instanceof TransportFailure) throw this.failure('unavailable', null, `${method}: ${err.message}`);
      throw err;
    }
  }

  /**
   * For calls that are safe to repeat. Only a transport failure is retried — an
   * answer does not change. With a deadline, each attempt's timeout is cut to
   * what is left of it, and an attempt that would start at or past it is not
   * made (F-092-ab).
   */
  private async retried(
    method: string,
    credentials: GatewayCredentials,
    body: Record<string, unknown>,
    deadlineAt?: number,
  ): Promise<Record<string, unknown>> {
    const remaining = () => (deadlineAt === undefined ? this.timeoutMs : deadlineAt - this.now());
    for (let attempt = 0; ; attempt++) {
      if (remaining() <= 0) {
        throw this.failure('unavailable', null, `${method}: deadline reached after ${attempt} attempt(s)`);
      }
      try {
        return await this.post(method, credentials, body, Math.min(this.timeoutMs, remaining()));
      } catch (err) {
        if (!(err instanceof TransportFailure)) throw err;
        if (attempt >= RETRY_DELAYS_MS.length || remaining() <= RETRY_DELAYS_MS[attempt]) {
          throw this.failure('unavailable', null, `${method} after ${attempt + 1} attempts: ${err.message}`);
        }
        await this.sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  /**
   * The only place the merchant id is written, and only into the request body.
   * No error built below quotes the body, so it cannot leak into a log.
   */
  private async post(
    method: string,
    credentials: GatewayCredentials,
    body: Record<string, unknown>,
    timeoutMs = this.timeoutMs,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.host}/v4/payment/${method}.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ merchant_id: credentials.merchantId, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TransportFailure((err as Error).name || 'network error');
    }
    if (response.status >= 500) throw new TransportFailure(`HTTP ${response.status}`);

    let parsed: ZarinpalBody;
    try {
      parsed = (await response.json()) as ZarinpalBody;
    } catch {
      // A 4xx without JSON is an answer we cannot read, not one worth repeating.
      throw this.failure('unexpected', null, `${method}: HTTP ${response.status} with no JSON body`);
    }

    // Zarinpal reports a refusal in `errors` (often with a 4xx), a result in `data`.
    const errors = parsed.errors;
    if (errors && !Array.isArray(errors) && errors.code !== undefined) {
      const code = String(errors.code);
      throw this.failure(FAILURE_BY_CODE[code] ?? 'unexpected', code, `${method} refused${refusalDetail(errors, credentials.merchantId)}`);
    }
    if (!parsed.data || Array.isArray(parsed.data)) {
      throw this.failure('unexpected', null, `${method}: HTTP ${response.status} with no data`);
    }
    return parsed.data;
  }

  private requireCode(data: Record<string, unknown>, success: number[]): number {
    const code = Number(data['code']);
    if (success.includes(code)) return code;
    const key = String(data['code']);
    throw this.failure(FAILURE_BY_CODE[key] ?? 'unexpected', key, 'unsuccessful code in data');
  }

  /** Zarinpal takes a JSON number; refuse an amount JSON cannot carry exactly. */
  private wireAmount(amountMinor: bigint): number {
    if (amountMinor <= BigInt(0) || amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw this.failure('invalid_request', null, `amount ${amountMinor} is not a positive safe integer`);
    }
    return Number(amountMinor);
  }

  private failure(reason: GatewayFailureReason, code: string | null, detail: string): GatewayFailure {
    return new GatewayFailure(this.name, reason, code, detail);
  }
}
