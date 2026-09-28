import { RealtimeEvents } from "@/generated/wire";
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
  /** The gateway reversed it: the bank is returning the money (F-092-ae). */
  | { kind: "reversed" }
  | { kind: "closed" };

/**
 * Every 10 s: the retry ladder's first rung is 30 s and the sweep ticks every
 * 5 min, so faster buys nothing, and 90 reads in the token's 15 minutes stays
 * well inside `WALLET_PAYMENT_RATE_LIMIT` (300).
 */
export const PENDING_POLL_MS = 10_000;

export function pendingStateOf(row: WalletPaymentRow | null): PendingState {
  // A read that failed is not an outcome; the next poll asks again. An expired
  // payment is still asked about for a week and credited when the bank confirms
  // it (ADR-0046 decision 1) — "not settled" would send the payer to pay again.
  if (row === null || row.status === "pending" || row.status === "expired") return { kind: "waiting" };
  // The reference passes the success page's own printable allowlist.
  if (row.status === "success") return { kind: "credited", reference: readSuccess(row.referenceId ?? undefined, undefined).reference };
  if (row.failureCode === "reversed") return { kind: "reversed" };
  return { kind: "closed" };
}

/** A payment event on the user's channel: which payment, what it credited, and in what. */
export interface PaymentEvent {
  paymentId: string;
  amountCredited: string;
  currencyCode: string;
}

/**
 * A late credit announced on the payer's own `user:` channel (F-067-l,
 * ADR-0045), or `null` for anything else on it. The amount must look like
 * billing's decimal string — it is printed.
 */
export function readPaymentCredited(payload: unknown): PaymentEvent | null {
  return readPaymentEvent(payload, RealtimeEvents.paymentConfirmed);
}

/**
 * A payment the gateway reversed, announced on the same channel (F-067-m,
 * ADR-0046 decision 5) — the bank is returning the money — or `null`.
 */
export function readPaymentReversed(payload: unknown): PaymentEvent | null {
  return readPaymentEvent(payload, RealtimeEvents.paymentReversed);
}

/**
 * `currencyCode` is what `amountCredited` is in (F-116-h3). An event without
 * one — written before the payload carried it — is not read: a figure with no
 * currency is not shown as if it had one.
 */
function readPaymentEvent(payload: unknown, type: string): PaymentEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== type) return null;
  if (typeof p.paymentId !== "string" || !p.paymentId) return null;
  if (typeof p.amountCredited !== "string" || !/^\d{1,16}(\.\d{1,2})?$/.test(p.amountCredited)) return null;
  if (typeof p.currencyCode !== "string" || !/^[A-Z]{3}$/.test(p.currencyCode)) return null;
  return { paymentId: p.paymentId, amountCredited: p.amountCredited, currencyCode: p.currencyCode };
}
