import type { WalletPaymentRow } from "@/lib/billing-api";
import { PENDING_POLL_MS, pendingStateOf } from "./pending-payment";

/**
 * `/payment/pending` (F-093-l, ADR-0044 decision 7). What breaks silently:
 *  - a verifying payment read as failed — the payer pays again;
 *  - a credited one never turning into the success card;
 *  - a poll so fast it spends the route's budget (300 per 15 min) in one visit.
 */
const row = (overrides: Partial<WalletPaymentRow>): WalletPaymentRow => ({
  id: "77777777-7777-4777-8777-777777777777",
  status: "pending",
  amountRequested: "10.00",
  fee: "0.00",
  discount: "0.00",
  amountCredited: "10.00",
  charge: { amountMinor: "1000000", rate: null },
  trackingCode: "A1",
  referenceId: null,
  cardPanMasked: null,
  failureCode: null,
  gateway: null,
  createdAt: "2026-09-14T10:00:00Z",
  expiresAt: null,
  verifying: true,
  ...overrides,
});

describe("pendingStateOf", () => {
  it("keeps waiting while the payment is pending, verifying or not yet", () => {
    expect(pendingStateOf(row({}))).toEqual({ kind: "waiting" });
    // Between the callback and the first retry write the flag can still be false.
    expect(pendingStateOf(row({ verifying: false }))).toEqual({ kind: "waiting" });
  });

  it("becomes the success card, with the reference, once credited", () => {
    expect(pendingStateOf(row({ status: "success", referenceId: "900900900", verifying: false }))).toEqual({
      kind: "credited",
      reference: "900900900",
    });
  });

  it("drops a reference outside the printable alphabet", () => {
    expect(pendingStateOf(row({ status: "success", referenceId: "<script>" }))).toEqual({ kind: "credited", reference: null });
  });

  it.each(["failed", "expired"] as const)("says a %s payment was not settled", (status) => {
    expect(pendingStateOf(row({ status, verifying: false }))).toEqual({ kind: "closed" });
  });

  it("keeps waiting when the payment could not be read — a network blip is not an outcome", () => {
    expect(pendingStateOf(null)).toEqual({ kind: "waiting" });
  });
});

describe("the poll", () => {
  it("stays inside the route's budget over its 15-minute window", () => {
    expect((15 * 60 * 1000) / PENDING_POLL_MS).toBeLessThanOrEqual(300 / 2);
  });
});
