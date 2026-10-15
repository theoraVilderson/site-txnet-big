// A payment a person confirms when the gateway would not (F-093-n).
import { call } from "./client";
import type { GatewaySource } from "./gateways";

/** Why a transfer waits on a person (billing `TransferReviewReason`, F-805-a). */
export type TransferReviewReason =
  | "underpaid"
  | "overpaid"
  | "late"
  | "wrong_destination"
  | "duplicate_ref"
  | "amount_collision"
  | "no_match"
  | "proof_only";

/** What the queue shows of a manual transfer (billing `TransferView`, F-805-a). */
export interface TransferView {
  /** The method kind (`card_to_card`, …); the panel draws the proof through its registry. */
  kind: string;
  destinationLabel: string;
  /** In `currencyCode`'s minor unit — the charge currency the payer sends, not the wallet's. */
  expectedAmountMinor: string;
  currencyCode: string;
  decimals: number;
  /** A wallet's network as the seller wrote it; null for a card. */
  network: string | null;
  proof: Record<string, unknown> | null;
  proofSubmittedAt: string | null;
  reviewReason: TransferReviewReason | null;
  /** The receipt, signed for five minutes; a reload mints a fresh one. */
  receiptUrl: string | null;
  receiptUrlExpiresAt: string | null;
  /** Whether a reject may still send the proof back to the payer (once). */
  canReturn: boolean;
}

/** An open payment a person may act on (F-092-z; every `pending` or `expired` one since F-092-af). */
export interface VerifyingPayment {
  id: string;
  status: "pending" | "expired";
  tenantId: string | null;
  userId: string;
  source: GatewaySource;
  gatewayId: string | null;
  gatewayName: string | null;
  providerName: string | null;
  amountRequested: string;
  amountCredited: string;
  /** The payment's own currency (F-116-h3). */
  currencyCode: string;
  chargedAmountMinor: string;
  authority: string | null;
  createdAt: string;
  verifyAttempts: number;
  nextVerifyAt: string | null;
  /** Still verifying a day after it was made (F-092-y). */
  flaggedAt: string | null;
  /** A manual transfer's destination, amount and proof (F-805-a); null for every other payment. */
  transfer: TransferView | null;
}

/** What asking the gateway, or confirming by hand, came to (billing `ManualOutcome`). */
export type ManualOutcome =
  | "credited"
  | "already_settled"
  | "refused"
  | "mismatch"
  | "unsettled"
  | "confirmed_manually"
  /** A person closed it; the gateway saw no money (F-092-ak). */
  | "rejected_manually"
  /** Not rejected: the payer is still at the bank (F-092-ak). */
  | "still_in_bank"
  /** Not closed: a transfer's proof went back to the payer to send again (F-805-a). */
  | "returned_for_proof";

export interface ManualAnswer {
  paymentId: string;
  outcome: ManualOutcome;
  gatewayStatus: string | null;
  referenceId: string | null;
}

/** Manual-confirmation calls — spread into `billingApi` (`lib/billing-api.ts`). */
export const manualPaymentCalls = {
  /**
   * Every gateway the caller may manage (F-102-d): the platform owner all of
   * them, a tenant its own. Billing decides which; this sends no tenant.
   */
  /** Payments waiting on a person, in the caller's scope (F-093-n → F-092-z). */
  async manualPayments(): Promise<VerifyingPayment[]> {
    return call<VerifyingPayment[]>("/payments/manual", { method: "GET" });
  },

  /** Ask the gateway now; whatever it settles is settled by billing's ordinary path. */
  async manualInquire(id: string): Promise<ManualAnswer> {
    return call<ManualAnswer>(`/payments/manual/${encodeURIComponent(id)}/inquire`, { method: "POST" });
  },

  /** Billing asks the gateway once more first; it credits by hand only if that stays unsettled. */
  /** Attach an authority whose write was lost, then ask the gateway (F-092-af). */
  async manualAttachAuthority(id: string, authority: string): Promise<ManualAnswer> {
    return call<ManualAnswer>(`/payments/manual/${encodeURIComponent(id)}/authority`, {
      method: "POST",
      body: JSON.stringify({ authority }),
    });
  },

  async manualConfirm(id: string, body: { referenceId: string; reason: string }): Promise<ManualAnswer> {
    return call<ManualAnswer>(`/payments/manual/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  /**
   * End a payment nobody paid (F-092-ak). Billing asks the gateway first and never rejects money it can see.
   * `resubmit` on a transfer sends its proof back to the payer once instead (F-805-a).
   */
  async manualReject(id: string, reason: string, resubmit = false): Promise<ManualAnswer> {
    return call<ManualAnswer>(`/payments/manual/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify(resubmit ? { reason, resubmit } : { reason }),
    });
  },
};
