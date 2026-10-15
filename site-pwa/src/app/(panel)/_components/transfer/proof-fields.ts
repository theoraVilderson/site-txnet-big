import { foldDigits } from "./banks";
import type { FieldRefusal } from "./transfer-kind";

/**
 * A payer's proof fields as billing's kinds check them (`payment/manual/kinds/`,
 * `manual-method.ts`), mirrored so a refusal is caught before the payer spends
 * one of the 20 tries the proof routes allow. Ids mean the same in every kind.
 * Billing still decides; a field missing here is only checked for presence.
 */

/** The proof field that is an uploaded image, sent as its stored key. */
export const RECEIPT_FIELD = "receiptImage";
/** The proof field that is an instant, typed as a local date and time. */
export const PAID_AT_FIELD = "paidAt";

const SHAPES: Readonly<Record<string, (value: string) => boolean>> = {
  trackingCode: (v) => /^[A-Za-z0-9]{4,40}$/.test(v),
  sourceCardLast4: (v) => /^\d{4}$/.test(v),
  txHash: (v) => /^(0x)?[A-Za-z0-9]{16,128}$/.test(v),
  [PAID_AT_FIELD]: (v) => !Number.isNaN(Date.parse(v)),
};

/** The fields billing folds before checking (a card's codes); a time or a hash is only trimmed. */
const FOLDED: ReadonlySet<string> = new Set(["trackingCode", "sourceCardLast4"]);

/** A typed proof value as billing will read it: trimmed, and a code's digits folded from any script. */
export function foldProof(id: string, raw: string): string {
  return FOLDED.has(id) ? foldDigits(raw.trim()) : raw.trim();
}

/** Why one typed proof field would be refused, or null. The receipt is checked by whether it was uploaded. */
export function proofRefusal(id: string, raw: string): FieldRefusal | null {
  const value = foldProof(id, raw);
  if (!value) return "missing";
  return SHAPES[id] && !SHAPES[id](value) ? "invalid" : null;
}
