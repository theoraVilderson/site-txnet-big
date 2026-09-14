import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PANEL_MENU, isMenuGroup } from "../../_lib/panel-menu";
import { PANEL_MANUAL_PAYMENTS } from "@/lib/routes";
import {
  MANUAL_KEYS,
  OUTCOME_KEYS,
  PAYMENT_CONFIRM_MANUAL,
  canAttachAuthority,
  canConfirmByHand,
  canRejectByHand,
  stateBadges,
  validateAuthority,
  validateConfirm,
  validateReject,
} from "./_lib/manual-confirm";
import type { VerifyingPayment } from "@/lib/billing-api";

/**
 * The manual confirmation screen (F-093-n, ADR-0044 decision 6). What breaks
 * silently:
 *  - an outcome billing answers with no sentence here — a blank line at the
 *    moment a person decides about someone's money. The union is read out of
 *    the service's own source;
 *  - the form accepting what billing refuses (a wasted confirm) — the limits
 *    mirror `manual-confirm.schema.ts`;
 *  - "confirm by hand" offered before the gateway was asked on this screen, or
 *    after it answered. Inquire first is the screen's whole shape;
 *  - the menu showing the entry to someone without `payment.confirm_manual`.
 */
const REPO = join(__dirname, "../../../../../..");
const SERVICE = join(REPO, "txnet-backend/billing-service/src/app/payment/deposit/manual-confirm.service.ts");
const LOCALES = join(REPO, "locales/frontend/langs");

function outcomesBillingCanSend(): string[] {
  const union = /export type ManualOutcome =([\s\S]*?);/.exec(readFileSync(SERVICE, "utf8"));
  if (!union) throw new Error("ManualOutcome is no longer a literal union — this test is stale");
  return [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("the outcomes billing can answer", () => {
  it("each have a sentence on this screen", () => {
    expect(Object.keys(OUTCOME_KEYS).sort()).toEqual(outcomesBillingCanSend().sort());
  });
});

describe("validateConfirm", () => {
  it("accepts a reference and a reason inside billing's limits, trimmed", () => {
    expect(validateConfirm({ referenceId: " 900900900 ", reason: "checked the gateway panel" })).toEqual({
      ok: true,
      body: { referenceId: "900900900", reason: "checked the gateway panel" },
    });
  });

  it.each([
    [{ referenceId: "", reason: "checked the gateway panel" }, "referenceId"],
    [{ referenceId: "x".repeat(65), reason: "checked the gateway panel" }, "referenceId"],
    [{ referenceId: "900", reason: "ok" }, "reason"],
    [{ referenceId: "900", reason: "x".repeat(501) }, "reason"],
  ])("refuses %j on %s", (input, field) => {
    const out = validateConfirm(input);
    expect(out.ok).toBe(false);
    expect(out.ok ? null : Object.keys(out.errors)).toContain(field);
  });
});

describe("canConfirmByHand", () => {
  it("only once the gateway was asked here and left it unsettled", () => {
    expect(canConfirmByHand(null)).toBe(false);
    expect(canConfirmByHand("unsettled")).toBe(true);
    for (const settled of ["credited", "already_settled", "refused", "mismatch", "confirmed_manually"] as const) {
      expect(canConfirmByHand(settled)).toBe(false);
    }
  });
});

// F-093-o (ADR-0046 decision 7): every open payment is listed, so the badges
// are what tells a person which one needs them.
const payment = (overrides: Partial<VerifyingPayment>): VerifyingPayment => ({
  id: "77777777-7777-4777-8777-777777777777",
  status: "pending",
  tenantId: null,
  userId: "44444444-4444-4444-8444-444444444444",
  source: "tenant",
  gatewayId: null,
  gatewayName: null,
  providerName: "zarinpal",
  amountRequested: "10.00",
  amountCredited: "10.00",
  chargedAmountMinor: "1000000",
  authority: "A1",
  createdAt: "2026-09-14T10:00:00Z",
  verifyAttempts: 0,
  nextVerifyAt: null,
  flaggedAt: null,
  ...overrides,
});

describe("stateBadges", () => {
  it.each<[string, Partial<VerifyingPayment>, string[]]>([
    ["a payer still at the bank", {}, ["waiting"]],
    ["a verifying payment", { nextVerifyAt: "2026-09-14T10:01:00Z", verifyAttempts: 1 }, ["verifying"]],
    ["a flagged one", { nextVerifyAt: "2026-09-14T11:00:00Z", flaggedAt: "2026-09-15T10:00:00Z" }, ["verifying", "flagged"]],
    ["an expired one", { status: "expired" }, ["expired"]],
    ["one whose authority was lost", { authority: null }, ["waiting", "noAuthority"]],
  ])("names %s", (_what, overrides, badges) => {
    expect(stateBadges(payment(overrides))).toEqual(badges);
  });

  it("has a sentence for every badge, in the keys", () => {
    for (const badge of ["waiting", "verifying", "flagged", "expired", "noAuthority"] as const) {
      expect(MANUAL_KEYS.state[badge]).toBeTruthy();
    }
  });
});

describe("attaching a lost authority", () => {
  it("is offered only for a payment that has none", () => {
    expect(canAttachAuthority(payment({ authority: null }))).toBe(true);
    expect(canAttachAuthority(payment({ authority: "A1" }))).toBe(false);
  });

  it("mirrors billing's limits, trimmed", () => {
    expect(validateAuthority(" A000123 ")).toEqual({ ok: true, authority: "A000123" });
    expect(validateAuthority("  ")).toEqual({ ok: false, error: MANUAL_KEYS.authorityForm.invalid });
    expect(validateAuthority("x".repeat(65))).toEqual({ ok: false, error: MANUAL_KEYS.authorityForm.invalid });
  });
});

// F-093-p (F-092-ak): ending a payment nobody paid. The same shape as
// confirming — the gateway asked on this screen first, and a reason billing keeps.
describe("rejecting by hand", () => {
  it("is offered only once the gateway was asked here and left it unsettled", () => {
    expect(canRejectByHand(null)).toBe(false);
    expect(canRejectByHand("unsettled")).toBe(true);
    for (const outcome of [
      "credited",
      "already_settled",
      "refused",
      "mismatch",
      "confirmed_manually",
      "rejected_manually",
      "still_in_bank",
    ] as const) {
      expect(canRejectByHand(outcome)).toBe(false);
    }
  });

  it("mirrors billing's reason limits, trimmed", () => {
    expect(validateReject("  the payer never paid ")).toEqual({ ok: true, reason: "the payer never paid" });
    expect(validateReject("ok")).toEqual({ ok: false, error: MANUAL_KEYS.rejectForm.invalidReason });
    expect(validateReject("x".repeat(501))).toEqual({ ok: false, error: MANUAL_KEYS.rejectForm.invalidReason });
  });
});

describe("the menu", () => {
  it("shows the screen only to a holder of payment.confirm_manual", () => {
    const links = PANEL_MENU.flatMap((e) => (isMenuGroup(e) ? e.children : [e]));
    const entry = links.find((l) => l.href === PANEL_MANUAL_PAYMENTS);
    expect(entry?.requires).toEqual([PAYMENT_CONFIRM_MANUAL]);
  });
});

describe("every key this screen can reach", () => {
  const flatten = (v: unknown): string[] =>
    typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(flatten) : [];
  const shipped = (lang: string) => {
    const out = new Set<string>();
    const walk = (prefix: string, value: unknown) => {
      if (value && typeof value === "object") for (const [k, c] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, c);
      else if (typeof value === "string") out.add(prefix);
    };
    walk("", JSON.parse(readFileSync(join(LOCALES, lang, "common.json"), "utf8")));
    return out;
  };

  it.each(["en", "fa"])("resolves in %s", (lang) => {
    const keys = shipped(lang);
    expect(flatten(MANUAL_KEYS).filter((k) => !keys.has(k))).toEqual([]);
  });
});
