import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** Every string these two pages can show. */
export const PAYMENT_RESULT_KEYS = FrontendI18nKeys.common.paymentResult;

/**
 * The five codes `billing`'s callback can redirect with, each with the sentence
 * this panel explains it by (`domains/billing/contract.deposit.md`). They are
 * legacy's names verbatim, and `payment-result.test.ts` reads the service's own
 * union to keep them that way — a code renamed there without a key here is a
 * blank card at the end of a payment.
 *
 * This is the one place the panel writes a message for a backend failure
 * ([contract.errors.md](../../../../../docs/interfaces/panel-web/contract.errors.md)
 * says `auth-api` translates its own): what arrives on the query string is a
 * code, not a sentence, because the bank redirected the browser here and no
 * call of ours was answered.
 */
export const PAYMENT_FAILURE_KEYS = {
  INVALID_PARAMS: PAYMENT_RESULT_KEYS.failure.INVALID_PARAMS,
  TRANSACTION_NOT_FOUND: PAYMENT_RESULT_KEYS.failure.TRANSACTION_NOT_FOUND,
  GATEWAY_CONNECTION_ERROR: PAYMENT_RESULT_KEYS.failure.GATEWAY_CONNECTION_ERROR,
  VERIFICATION_FAILED: PAYMENT_RESULT_KEYS.failure.VERIFICATION_FAILED,
  SYSTEM_ERROR: PAYMENT_RESULT_KEYS.failure.SYSTEM_ERROR,
} as const;

export type PaymentFailureCode = keyof typeof PAYMENT_FAILURE_KEYS;

/** One value of the query string, however many times it appears. */
export type QueryValue = string | string[] | undefined;

function first(value: QueryValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export interface PaymentFailure {
  /** `null` when the code is not one of the five — nothing unrecognised is printed. */
  code: PaymentFailureCode | null;
  messageKey: string;
}

/**
 * What the failure page shows for `?error=`.
 *
 * An unrecognised value gets the general sentence and **is not echoed**. Legacy
 * printed whatever the query string carried as `Error Code: …`, which is a
 * stranger's text on our page under our branding at the moment a user is most
 * willing to follow an instruction about their money.
 */
export function readFailure(raw: QueryValue): PaymentFailure {
  const value = first(raw);
  if (value !== undefined && value in PAYMENT_FAILURE_KEYS) {
    const code = value as PaymentFailureCode;
    return { code, messageKey: PAYMENT_FAILURE_KEYS[code] };
  }
  return { code: null, messageKey: PAYMENT_RESULT_KEYS.failure.unknown };
}

/**
 * A gateway's receipt number as it is allowed to be printed: the alphabet every
 * driver's reference actually uses, and nothing else, for the same reason
 * `readFailure` refuses an unknown code.
 */
const REFERENCE = /^[A-Za-z0-9._:-]{1,64}$/;

export interface PaymentSuccess {
  /** Absent on a row settled before the column existed, or by an admin with none. */
  reference: string | null;
  /** A reload, a retried webhook, or a redirect that raced another. */
  alreadyPaid: boolean;
}

/**
 * What the success page shows for `?ref=` and `?already=`.
 *
 * **A missing reference is not a failure.** The callback settled the payment
 * before it redirected here; the reference is the receipt, not the verdict.
 * Legacy branched its whole page on `ref` and told a paid user their payment
 * had failed.
 */
export function readSuccess(ref: QueryValue, already: QueryValue): PaymentSuccess {
  const value = first(ref);
  return {
    reference: value !== undefined && REFERENCE.test(value) ? value : null,
    // The flag billing sets, exactly (`deposit-callback.controller.ts`).
    alreadyPaid: first(already) === "1",
  };
}
