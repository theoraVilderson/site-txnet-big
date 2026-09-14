import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { ManualOutcome, VerifyingPayment } from "@/lib/billing-api";

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

/**
 * What a person needs to know about an open payment at a glance (F-093-o,
 * ADR-0046 decision 7): every `pending` or `expired` one is listed now, so the
 * badges carry the triage.
 *  - `waiting`: pending and not verifying — most likely a payer still at the bank;
 *  - `verifying`: the gateway met a verify with silence and is being asked again;
 *  - `flagged`: a person should look (a day, or half a gateway's window);
 *  - `expired`: the clock ran out; billing still asks the gateway for a week;
 *  - `noAuthority`: the authority was lost — attach it from the gateway's panel.
 */
export type StateBadge = "waiting" | "verifying" | "flagged" | "expired" | "noAuthority";

export function stateBadges(row: VerifyingPayment): StateBadge[] {
  const badges: StateBadge[] = [];
  if (row.status === "expired") badges.push("expired");
  else badges.push(row.nextVerifyAt ? "verifying" : "waiting");
  if (row.flaggedAt) badges.push("flagged");
  if (row.authority === null) badges.push("noAuthority");
  return badges;
}

/** Only a payment with no authority takes one — billing refuses the rest (`authority_present`). */
export function canAttachAuthority(row: VerifyingPayment): boolean {
  return row.authority === null;
}

/** billing's `manualAuthoritySchema`, mirrored. */
export function validateAuthority(input: string): { ok: true; authority: string } | { ok: false; error: string } {
  const authority = input.trim();
  return authority.length >= 1 && authority.length <= 64
    ? { ok: true, authority }
    : { ok: false, error: MANUAL_KEYS.authorityForm.invalid };
}

