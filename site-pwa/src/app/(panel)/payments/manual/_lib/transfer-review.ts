import type { TransferReviewReason, VerifyingPayment } from "@/lib/billing-api";
import { RECEIPT_FIELD } from "../../../_components/transfer/proof-fields";
import { transferKind } from "../../../_components/transfer/transfer-kinds";
import { MANUAL_KEYS } from "./manual-confirm";

/** One sentence per reason billing can write (F-805-a); a `Record`, so a new reason does not compile until it has one. */
export const REVIEW_REASON_KEYS: Record<TransferReviewReason, string> = {
  underpaid: MANUAL_KEYS.transfer.reason.underpaid,
  overpaid: MANUAL_KEYS.transfer.reason.overpaid,
  late: MANUAL_KEYS.transfer.reason.late,
  wrong_destination: MANUAL_KEYS.transfer.reason.wrong_destination,
  duplicate_ref: MANUAL_KEYS.transfer.reason.duplicate_ref,
  amount_collision: MANUAL_KEYS.transfer.reason.amount_collision,
  no_match: MANUAL_KEYS.transfer.reason.no_match,
  proof_only: MANUAL_KEYS.transfer.reason.proof_only,
};

/**
 * A transfer has no gateway to ask — billing answers `unaskable` and the
 * reviewer learns nothing from "ask the gateway". Its confirm and reject are
 * offered at once, judged by the proof (contract.manual-transfer.md, the queue).
 */
export function judgedWithoutAsking(row: Pick<VerifyingPayment, "transfer">): boolean {
  return row.transfer !== null;
}

/** The proof as rows of text: the kind's fields in its order, then any it does not declare; the receipt is drawn apart. */
export function proofRows(kind: string, proof: Record<string, unknown> | null): [string, string][] {
  if (!proof) return [];
  const declared = transferKind(kind).proofFields;
  const ids = [...declared.filter((id) => id in proof), ...Object.keys(proof).filter((id) => !declared.includes(id))];
  return ids.filter((id) => id !== RECEIPT_FIELD).map((id) => [id, String(proof[id])]);
}

/** The payer's reference (a tracking code, a tx hash) — what the confirm form's reference starts as. */
export function referenceOf(kind: string, proof: Record<string, unknown> | null): string {
  const field = transferKind(kind).refProofField;
  const value = field && proof ? proof[field] : undefined;
  return typeof value === "string" ? value : "";
}

/** Whether a reject may send the proof back instead of closing (billing allows it once: `canReturn`). */
export function rejectChoice(row: Pick<VerifyingPayment, "transfer">): "may_return" | "close_only" {
  return row.transfer?.canReturn ? "may_return" : "close_only";
}
