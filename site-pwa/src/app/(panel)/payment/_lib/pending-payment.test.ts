import type { WalletPaymentRow } from "@/lib/billing-api";
import { PENDING_POLL_MS, pendingStateOf, readPaymentCredited, readPaymentReversed } from "./pending-payment";

/**
 * `/payment/pending` (F-093-l, ADR-0044 decision 7). What breaks silently:
 *  - a verifying payment read as failed — the payer pays again;
 *  - a credited one never turning into the success card;
 *  - a poll so fast it spends the route's budget (300 per 15 min) in one visit.
 */
const row = (overrides: Partial<WalletPaymentRow>): WalletPaymentRow => ({
  currencyCode: "USD",
  id: "77777777-7777-4777-8777-777777777777",
  status: "pending",
  amountRequested: "10.00",
  fee: "0.00",
  tax: "0.00",
  taxRatePercent: null,
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

  it("says a failed payment was not settled", () => {
    expect(pendingStateOf(row({ status: "failed", verifying: false }))).toEqual({ kind: "closed" });
  });

  // F-093-o (ADR-0046 decision 1): an expired payment is still asked about for a
  // week and is credited when the bank confirms it — "not settled" would send
  // the payer to pay again.
  it("keeps waiting on an expired payment: billing still asks the gateway about it", () => {
    expect(pendingStateOf(row({ status: "expired", verifying: false }))).toEqual({ kind: "waiting" });
  });

  it("says the bank is returning a payment the gateway reversed (F-092-ae)", () => {
    expect(pendingStateOf(row({ status: "failed", failureCode: "reversed", verifying: false }))).toEqual({ kind: "reversed" });
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

/**
 * The live half of F-067-l (ADR-0045): worker-service publishes
 * `{type:'billing.payment.confirmed', paymentId, amountCredited}` on the
 * payer's `user:` channel when a late credit lands. A stranger's shape must
 * not reach a toast.
 */
describe("readPaymentCredited", () => {
  it("reads the event worker-service publishes", () => {
    expect(
      readPaymentCredited({ type: "billing.payment.confirmed", paymentId: "p-1", amountCredited: "19.80", currencyCode: "IRR" }),
    ).toEqual({ paymentId: "p-1", amountCredited: "19.80", currencyCode: "IRR" });
  });

  it.each([
    null,
    "billing.payment.confirmed",
    { type: "wallet.changed", paymentId: "p-1", amountCredited: "19.80" },
    { type: "billing.payment.confirmed", paymentId: "p-1", amountCredited: "<b>9</b>" },
    { type: "billing.payment.confirmed", amountCredited: "19.80" },
    // Written before the event named its currency (F-116-h3): a figure with no currency is not shown.
    { type: "billing.payment.confirmed", paymentId: "p-1", amountCredited: "19.80" },
  ])("ignores %j", (payload) => {
    expect(readPaymentCredited(payload)).toBeNull();
  });
});

describe("readPaymentReversed (F-067-m)", () => {
  it("reads the event worker-service publishes when the gateway reversed a payment", () => {
    expect(
      readPaymentReversed({ type: "billing.payment.reversed", paymentId: "p-1", amountCredited: "19.80", currencyCode: "IRR" }),
    ).toEqual({ paymentId: "p-1", amountCredited: "19.80", currencyCode: "IRR" });
  });

  it.each([
    null,
    { type: "billing.payment.confirmed", paymentId: "p-1", amountCredited: "19.80" },
    { type: "billing.payment.reversed", paymentId: "p-1", amountCredited: "<b>9</b>" },
    { type: "billing.payment.reversed", amountCredited: "19.80" },
  ])("ignores %j", (payload) => {
    expect(readPaymentReversed(payload)).toBeNull();
  });

  it("is never read as a credit", () => {
    expect(readPaymentCredited({ type: "billing.payment.reversed", paymentId: "p-1", amountCredited: "19.80" })).toBeNull();
  });
});

