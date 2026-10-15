import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ApiError } from "@/lib/api-error";
import {
  PAYER_REASON_KEYS,
  PAY_KEYS,
  checkingText,
  TRANSFER_EVENTS,
  WARNING_MS,
  countdownOf,
  phaseOf,
  proofBody,
  proofErrors,
  refusedFields,
  stepOf,
  type TransferPhaseInput,
} from "./_lib/transfer-page";

/**
 * The pay page of a manual transfer (F-803-i). What breaks silently:
 *  - a payer whose window ran out reading "closed" while billing still takes a
 *    late proof (24 h grace) — they paid, and are told it is too late;
 *  - a proof form that sends what billing refuses, or holds back what it
 *    takes: the payer's one chance at a first-time proof, on a 20/15 min budget;
 *  - a page that waits for a reload to show the credit (C-14);
 *  - the ring turning amber at the wrong minute.
 */
const NOW = Date.parse("2026-10-15T10:00:00Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const transfer = (o: Partial<TransferPhaseInput> = {}): TransferPhaseInput => ({
  status: "pending",
  proofSubmittedAt: null,
  windowEndsAt: at(20),
  ...o,
});

describe("phaseOf", () => {
  it.each<[string, Partial<TransferPhaseInput>, ReturnType<typeof phaseOf>]>([
    ["an open window with no proof", {}, "send"],
    ["a window run out, still pending: the grace takes a late proof", { windowEndsAt: at(-1) }, "late"],
    ["a proof sent", { proofSubmittedAt: at(-2) }, "checking"],
    ["a proof sent after the window", { proofSubmittedAt: at(-2), windowEndsAt: at(-5) }, "checking"],
    ["credited", { status: "success", proofSubmittedAt: at(-2) }, "credited"],
    ["rejected by a person", { status: "failed", proofSubmittedAt: at(-2) }, "closed"],
    ["expired after the grace", { status: "expired", windowEndsAt: at(-60 * 25) }, "closed"],
  ])("%s", (_what, o, phase) => {
    expect(phaseOf(transfer(o), NOW)).toBe(phase);
  });
});

describe("stepOf", () => {
  it("walks send → proof → checking → credited", () => {
    expect(stepOf("send", false)).toBe(0);
    expect(stepOf("send", true)).toBe(1);
    expect(stepOf("late", false)).toBe(1);
    expect(stepOf("checking", false)).toBe(2);
    expect(stepOf("credited", false)).toBe(3);
  });
});

describe("countdownOf", () => {
  it("counts the window down, green until five minutes are left", () => {
    expect(countdownOf(at(20), 30, NOW)).toEqual({ leftMs: 20 * 60_000, fraction: 20 / 30, tone: "normal" });
    expect(countdownOf(new Date(NOW + WARNING_MS).toISOString(), 30, NOW).tone).toBe("warning");
  });

  it("stops at zero, never negative", () => {
    expect(countdownOf(at(-3), 30, NOW)).toEqual({ leftMs: 0, fraction: 0, tone: "over" });
  });
});

describe("proofErrors", () => {
  const card = ["receiptImage", "trackingCode", "sourceCardLast4"];

  it("holds back submit until every required field is there and well-formed", () => {
    expect(proofErrors(card, { trackingCode: "", sourceCardLast4: "12" }, { receiptKey: null })).toEqual({
      receiptImage: "missing",
      trackingCode: "missing",
      sourceCardLast4: "invalid",
    });
  });

  it("mirrors billing's shapes, digits folded from any script", () => {
    expect(proofErrors(card, { trackingCode: "۱۲۳۴۵۶", sourceCardLast4: "۴۳۲۱" }, { receiptKey: "t/transfers/p/receipt" })).toEqual({});
    expect(proofErrors(["txHash"], { txHash: "not a hash" }, { receiptKey: null })).toEqual({ txHash: "invalid" });
    expect(proofErrors(["paidAt"], { paidAt: "yesterday" }, { receiptKey: null })).toEqual({ paidAt: "invalid" });
  });

  it("asks only for what the seller required", () => {
    expect(proofErrors(["trackingCode"], { trackingCode: "ABC123" }, { receiptKey: null })).toEqual({});
  });
});

describe("proofBody", () => {
  it("sends exactly the required fields, folded, the receipt as its stored key", () => {
    expect(
      proofBody(["receiptImage", "trackingCode", "paidAt"], { trackingCode: " ۱۲۳۴۵۶ ", sourceCardLast4: "1234", paidAt: "2026-10-15T13:20" }, "t/transfers/p/receipt"),
    ).toEqual({
      receiptImage: "t/transfers/p/receipt",
      trackingCode: "123456",
      paidAt: new Date("2026-10-15T13:20").toISOString(),
    });
  });
});

describe("refusedFields", () => {
  it("reads billing's per-field refusal out of the error's facts", () => {
    const error = new ApiError("invalid_proof", { status: 400, reason: "invalid_proof", facts: { trackingCode: "invalid" } });
    expect(refusedFields(error)).toEqual({ trackingCode: "invalid" });
    expect(refusedFields(new Error("network"))).toEqual({});
  });
});

describe("live, never polled (C-14)", () => {
  it("re-reads when billing credits or reverses a payment", () => {
    expect([...TRANSFER_EVENTS].sort()).toEqual(["billing.payment.confirmed", "billing.payment.reversed"]);
  });

  it("the page keeps no timer but the countdown's clock", () => {
    const hook = readFileSync(join(__dirname, "_hooks/useTransfer.ts"), "utf8");
    expect(hook).toMatch(/useLiveReread\(/);
    expect(hook).not.toMatch(/setInterval\(/);
  });
});

describe("checkingText", () => {
  it("says the seller's usual time when they set one (F-803-l)", () => {
    expect(checkingText({ confirmationMode: "manual_admin_required", confirmWithinMinutes: 20 })).toEqual({
      key: PAY_KEYS.checking.manualWithin,
      vars: { minutes: "20" },
    });
  });

  it("says only that a person confirms it when they set none", () => {
    expect(checkingText({ confirmationMode: "manual_admin_required", confirmWithinMinutes: null })).toEqual({ key: PAY_KEYS.checking.manual });
  });

  it("an automatic gateway watches the network, whatever the figure", () => {
    expect(checkingText({ confirmationMode: "automatic", confirmWithinMinutes: 20 })).toEqual({ key: PAY_KEYS.checking.automatic });
  });
});

describe("why a transfer waits", () => {
  it("every reason billing can write has a sentence for the payer", () => {
    const schema = readFileSync(join(__dirname, "../../../../../../txnet-backend/prisma/domains/billing.prisma"), "utf8");
    const block = /enum TransferReviewReason \{([\s\S]*?)\}/.exec(schema)![1];
    const reasons = [...block.matchAll(/^\s+([a-z_]+)\s*$/gm)].map((m) => m[1]);
    expect(Object.keys(PAYER_REASON_KEYS).sort()).toEqual(reasons.sort());
  });
});
