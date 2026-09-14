import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PANEL_MENU, isMenuGroup } from "../../_lib/panel-menu";
import { PANEL_MANUAL_PAYMENTS } from "@/lib/routes";
import {
  MANUAL_KEYS,
  OUTCOME_KEYS,
  PAYMENT_CONFIRM_MANUAL,
  canConfirmByHand,
  validateConfirm,
} from "./_lib/manual-confirm";

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
