import type { GrantStatus, SpendingCap } from "@/lib/billing-api";
import { isNonZero } from "../../_lib/money";

/** Billing's bound on a cap's label (`spending-cap.schema.ts`): 1..40 characters. */
export const CAP_LABEL_MAX = 40;

/**
 * Statuses billing answers a cap for. `expired` and `cancelled` are closed:
 * billing answers them `404` like a missing id, so the section is not drawn.
 */
export function capOffered(status: GrantStatus): boolean {
  return status !== "expired" && status !== "cancelled";
}

/**
 * What the owner typed as a cap, in billing's shape — a decimal string above
 * zero with at most two places — or `null` when it is not one. Persian and
 * Arabic digits, the Persian decimal mark and thousands separators are read,
 * since a phone keyboard offers them. It only saves a round trip: billing
 * checks the same thing and its sentence is what a refusal shows.
 */
export function capAmount(raw: string): string | null {
  const latin = raw
    .trim()
    .replace(/[۰-۹٠-٩]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .replace(/٫/g, ".")
    .replace(/[,٬\s]/g, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(latin);
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = match[2] ?? "";
  if (/^0*$/.test(whole + fraction)) return null;
  return fraction ? `${whole}.${fraction}` : whole;
}

/** A stored amount back into the box: `"150000.00"` edits as `150000`, `"12.50"` as `12.50`. */
export function amountDraft(amount: string): string {
  return amount.replace(/\.00$/, "");
}

/**
 * Whether the cap is spent: billing's `left` is zero, so this service is cut as
 * an empty wallet cuts (`billing/contract.spending-cap.md` rule 4). Read off
 * billing's string — nothing here subtracts money.
 */
export function capReached(cap: SpendingCap): boolean {
  return !isNonZero(cap.left);
}
