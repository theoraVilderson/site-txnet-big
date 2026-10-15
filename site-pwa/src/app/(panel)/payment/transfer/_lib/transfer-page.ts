import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RealtimeEvents } from "@/generated/wire";
import { ApiError } from "@/lib/api-error";
import type { TransferReviewReason, TransferStatus } from "@/lib/billing-api";
import { PAID_AT_FIELD, RECEIPT_FIELD, foldProof, proofRefusal } from "../../../_components/transfer/proof-fields";
import type { FieldRefusal } from "../../../_components/transfer/transfer-kind";

/** Every string the pay page shows (C-06). */
export const PAY_KEYS = FrontendI18nKeys.common.transferPay;

/**
 * Where a manual transfer stands for its payer (contract.manual-transfer.md
 * "The pay page"):
 *  - `send`: the window is open and no proof has come;
 *  - `late`: the window ran out but billing still takes a proof for its grace
 *    (24 h) — the payer may well have paid, so the form stays;
 *  - `checking`: a proof is with a person;
 *  - `credited` / `closed`: billing settled it, either way.
 */
export type TransferPhase = "send" | "late" | "checking" | "credited" | "closed";

export type TransferPhaseInput = Pick<TransferStatus, "status" | "proofSubmittedAt" | "windowEndsAt">;

export function phaseOf(t: TransferPhaseInput, now: number): TransferPhase {
  if (t.status === "success") return "credited";
  if (t.status !== "pending") return "closed";
  if (t.proofSubmittedAt) return "checking";
  return Date.parse(t.windowEndsAt) > now ? "send" : "late";
}

/** The stepper's steps, in order. */
export const STEPS = ["send", "proof", "checking", "credited"] as const;

/** The active step: `send` becomes `proof` once the payer says they paid; a closed transfer stays where it stopped. */
export function stepOf(phase: TransferPhase, proofOpen: boolean): number {
  if (phase === "send") return proofOpen ? 1 : 0;
  if (phase === "late") return 1;
  if (phase === "checking" || phase === "closed") return 2;
  return 3;
}

/** The ring turns to the `warning` tone with five minutes left. */
export const WARNING_MS = 5 * 60_000;

export interface Countdown {
  leftMs: number;
  /** The share of the gateway's window left, 0..1 — what the ring draws. */
  fraction: number;
  tone: "normal" | "warning" | "over";
}

export function countdownOf(windowEndsAt: string, windowMinutes: number, now: number): Countdown {
  const leftMs = Math.max(0, Date.parse(windowEndsAt) - now);
  const fraction = windowMinutes > 0 ? Math.min(1, leftMs / (windowMinutes * 60_000)) : 0;
  const tone = leftMs === 0 ? "over" : leftMs <= WARNING_MS ? "warning" : "normal";
  return { leftMs, fraction, tone };
}

export type ProofDraft = Readonly<Record<string, string>>;
export type ProofErrors = Partial<Record<string, FieldRefusal>>;

/** Every required field that would be refused; submit stays disabled while this is not empty. */
export function proofErrors(requiredProof: readonly string[], draft: ProofDraft, receiptKey: string | null): ProofErrors {
  const errors: ProofErrors = {};
  for (const id of requiredProof) {
    const refusal = id === RECEIPT_FIELD ? (receiptKey ? null : "missing") : proofRefusal(id, draft[id] ?? "");
    if (refusal) errors[id] = refusal;
  }
  return errors;
}

/** The body billing takes: the required fields only, folded, a time as an instant, the receipt as its key. */
export function proofBody(requiredProof: readonly string[], draft: ProofDraft, receiptKey: string | null): Record<string, string> {
  const body: Record<string, string> = {};
  for (const id of requiredProof) {
    if (id === RECEIPT_FIELD) {
      if (receiptKey) body[id] = receiptKey;
    } else if (id === PAID_AT_FIELD) {
      body[id] = new Date(foldProof(id, draft[id] ?? "")).toISOString();
    } else {
      body[id] = foldProof(id, draft[id] ?? "");
    }
  }
  return body;
}

/** Billing's refusals of the whole proof (`ProofRejection`), each said to the payer with what to do. */
export const PROOF_REFUSAL_KEYS: Readonly<Record<string, string>> = PAY_KEYS.refusal;

const REFUSALS: ReadonlySet<string> = new Set<FieldRefusal>(["missing", "invalid", "checksum", "unknown_field"]);

/** Billing's per-field refusal (`error.facts`, `{trackingCode: 'invalid'}`), or nothing. */
export function refusedFields(error: unknown): ProofErrors {
  if (!(error instanceof ApiError)) return {};
  const out: ProofErrors = {};
  for (const [id, reason] of Object.entries(error.facts)) if (typeof reason === "string" && REFUSALS.has(reason)) out[id] = reason as FieldRefusal;
  return out;
}

/** What the page re-reads on (contract principle 3); `transfer_seen` joins with F-803-f. */
export const TRANSFER_EVENTS: readonly string[] = [RealtimeEvents.paymentConfirmed, RealtimeEvents.paymentReversed];

/** Why a transfer waits, said to its payer with what to do (billing `TransferReviewReason`). */
export const PAYER_REASON_KEYS: Record<TransferReviewReason, string> = {
  underpaid: PAY_KEYS.reason.underpaid,
  overpaid: PAY_KEYS.reason.overpaid,
  late: PAY_KEYS.reason.late,
  wrong_destination: PAY_KEYS.reason.wrong_destination,
  duplicate_ref: PAY_KEYS.reason.duplicate_ref,
  amount_collision: PAY_KEYS.reason.amount_collision,
  no_match: PAY_KEYS.reason.no_match,
  proof_only: PAY_KEYS.reason.proof_only,
};

/** The sentence for a reason billing sent, or null for one this panel does not know yet. */
export function payerReasonKey(reason: string | null): string | null {
  return reason && reason in PAYER_REASON_KEYS ? PAYER_REASON_KEYS[reason as TransferReviewReason] : null;
}
