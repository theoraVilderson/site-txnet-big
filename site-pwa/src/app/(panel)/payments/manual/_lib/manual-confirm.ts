import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { ManualOutcome } from "@/lib/billing-api";

/** Every string the screen can show (C-06). */
export const MANUAL_KEYS = FrontendI18nKeys.common.manualPayments;

/** billing's `PAYMENT_CONFIRM_MANUAL` — the menu entry needs it (F-092-z). */
export const PAYMENT_CONFIRM_MANUAL = "payment.confirm_manual";

/**
 * One sentence per word billing can answer. A `Record` over the union, so a
 * word added there does not compile here; `manual-payments.test.ts` reads the
 * service's own union to catch the case where both sides forgot.
 */
export const OUTCOME_KEYS: Record<ManualOutcome, string> = {
  credited: MANUAL_KEYS.outcome.credited,
  already_settled: MANUAL_KEYS.outcome.already_settled,
  refused: MANUAL_KEYS.outcome.refused,
  mismatch: MANUAL_KEYS.outcome.mismatch,
  unsettled: MANUAL_KEYS.outcome.unsettled,
  confirmed_manually: MANUAL_KEYS.outcome.confirmed_manually,
};

/**
 * Inquire first (ADR-0044 decision 6): the hand-confirm form is offered only
 * after the gateway was asked **on this screen** and still could not say.
 * Billing asks once more itself before crediting — this is the person's half.
 */
export function canConfirmByHand(lastOutcome: ManualOutcome | null): boolean {
  return lastOutcome === "unsettled";
}

export type ConfirmInput = { referenceId: string; reason: string };

export type ConfirmValidation =
  | { ok: true; body: ConfirmInput }
  | { ok: false; errors: Partial<Record<keyof ConfirmInput, string>> };

/** billing's `manual-confirm.schema.ts`, mirrored so a refusal is caught before the call. */
export function validateConfirm(input: ConfirmInput): ConfirmValidation {
  const referenceId = input.referenceId.trim();
  const reason = input.reason.trim();
  const errors: Partial<Record<keyof ConfirmInput, string>> = {};
  if (referenceId.length < 1 || referenceId.length > 64) errors.referenceId = MANUAL_KEYS.form.invalidReference;
  if (reason.length < 5 || reason.length > 500) errors.reason = MANUAL_KEYS.form.invalidReason;
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, body: { referenceId, reason } };
}
