// A payment a person confirms when the gateway would not (F-093-n).
import { call } from "./client";
import type { GatewaySource } from "./gateways";

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
  | "still_in_bank";

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

  /** End a payment nobody paid (F-092-ak). Billing asks the gateway first and never rejects money it can see. */
  async manualReject(id: string, reason: string): Promise<ManualAnswer> {
    return call<ManualAnswer>(`/payments/manual/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  },
};
