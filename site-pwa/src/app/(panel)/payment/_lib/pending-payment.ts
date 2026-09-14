import type { WalletPaymentRow } from "@/lib/billing-api";
import { readSuccess } from "./payment-result";

/**
 * What `/payment/pending` shows for the payment it polls (F-093-l,
 * ADR-0044 decision 7).
 *
 * The page exists because billing's callback met the gateway with silence: the
 * money may have moved, so the payer must not read "failed" and pay again.
 * Billing keeps asking the gateway (F-092-x/y); this only watches the row.
 */
export type PendingState =
  | { kind: "waiting" }
  | { kind: "credited"; reference: string | null }
  | { kind: "closed" };

/**
 * Every 10 s: the retry ladder's first rung is 30 s and the sweep ticks every
 * 5 min, so faster buys nothing, and 90 reads in the token's 15 minutes stays
 * well inside `WALLET_PAYMENT_RATE_LIMIT` (300).
 */
export const PENDING_POLL_MS = 10_000;

export function pendingStateOf(row: WalletPaymentRow | null): PendingState {
  // A read that failed is not an outcome; the next poll asks again.
  if (row === null || row.status === "pending") return { kind: "waiting" };
  // The reference passes the success page's own printable allowlist.
  if (row.status === "success") return { kind: "credited", reference: readSuccess(row.referenceId ?? undefined, undefined).reference };
  return { kind: "closed" };
}
