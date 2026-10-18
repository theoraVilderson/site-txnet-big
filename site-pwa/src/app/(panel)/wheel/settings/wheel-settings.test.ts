import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Me } from "@/lib/auth-api";
import type { WheelVersion } from "@/lib/engagement-api";
import { PANEL_WHEEL_SETTINGS } from "@/lib/routes";
import { PANEL_MENU, menuHrefs, visibleMenu } from "../../_lib/panel-menu";
import {
  PRIZES_MAX,
  PRIZES_MIN,
  PRIZE_LABEL_MAX,
  REFUSAL_KEYS,
  WHEEL_MANAGE,
  WHEEL_SETTINGS_KEYS,
  canManageWheel,
  capLastsSpins,
  emptyPrize,
  expectedCostPerSpin,
  formFromVersion,
  oddsPercents,
  validateWheelForm,
  wheelVersionBody,
  type WheelForm,
} from "./_lib/wheel-settings";

/**
 * The admin's wheel settings (F-707-f), over billing's
 * `/api/billing/engagement/wheel` (F-707-c, F-707-e). What breaks with nothing
 * red anywhere:
 *  - **odds that are not the odds given** — the page shows weight / Σ weight,
 *    and the expected cost is Σ weight × cost / Σ weight in whole cents, never
 *    a float (C-02); a wheel over its cap is stopped before the call, the way
 *    billing would refuse it (`expected_cost_over_cap`);
 *  - **a prize billing refuses for its shape** — each kind carries exactly its
 *    own fields, and `wallet_credit` is not offered at all (ADR-0111 point 2);
 *  - **a body the `.strict()` schema refuses**, or a refusal with no sentence.
 */
const REPO = join(__dirname, "../../../../../..");
const LOCALES = join(REPO, "locales/frontend/langs");
const ENGAGEMENT = join(REPO, "txnet-backend/billing-service/src/app/engagement");
const read = (file: string) => readFileSync(join(ENGAGEMENT, file), "utf8");

const ADMIN: Me = {
  userId: "u1",
  fullName: "Theora",
  role: { id: "r1", name: "Admin" },
  permissions: ["engagement.manage"],
  tenant: { id: "t-res", type: "reseller", isOwner: false },
  email: null,
  isImpersonated: false,
};
const SUPPORT: Me = { ...ADMIN, role: { id: "r2", name: "Support" }, permissions: ["user.search"] };
const TEMPLATE = "22222222-2222-4222-8222-222222222222";

const form = (over: Partial<WheelForm> = {}): WheelForm => ({
  isActive: true,
  cap: "10",
  cooldownHours: "0",
  maxSpins: "1",
  minAgeHours: "24",
  minPaid: "",
  minOrders: "",
  activeService: true,
  phoneVerified: true,
  userGroupId: "",
  prizes: [
    { ...emptyPrize(), label: "1 GB", prizeType: "bonus_traffic_gb", prizeValue: "1", weight: "30", costAmount: "4" },
    { ...emptyPrize(), label: "Nothing", prizeType: "empty", prizeValue: "0", weight: "70", costAmount: "0" },
  ],
  ...over,
});

describe("what billing can refuse this page with", () => {
  it("has a sentence for every reason, the report's included", () => {
    const union = /export type WheelAdminRejection =([\s\S]*?);/.exec(read("wheel-admin.service.ts"));
    const report = /export type WheelReportRejection =([\s\S]*?);/.exec(read("wheel-report.ts"));
    if (!union || !report) throw new Error("a rejection is no longer a literal union — this test is stale");
    const reasons = [...union[1].matchAll(/'([a-z_]+)'/g), ...report[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(Object.keys(REFUSAL_KEYS).sort()).toEqual(reasons.sort());
  });

  it("gates on the guard's own key and holds the schema's bounds", () => {
    expect(read("engagement-permission.guard.ts")).toContain(`ENGAGEMENT_MANAGE = '${WHEEL_MANAGE}'`);
    const schema = read("wheel-admin.schema.ts");
    expect(schema).toContain(`.min(${PRIZES_MIN}).max(${PRIZES_MAX})`);
    expect(schema).toContain(`.max(${PRIZE_LABEL_MAX})`);
  });
});

describe("who sees the page", () => {
  const hrefs = (me: Me) => menuHrefs(visibleMenu(PANEL_MENU, me.permissions, me.tenant.type, me.tenant.isOwner));
  it("is anyone holding engagement.manage, in any tenant", () => {
    expect(canManageWheel(ADMIN)).toBe(true);
    expect(canManageWheel(SUPPORT)).toBe(false);
    expect(canManageWheel(null)).toBe(false);
    expect(hrefs(ADMIN)).toContain(PANEL_WHEEL_SETTINGS);
    expect(hrefs(SUPPORT)).not.toContain(PANEL_WHEEL_SETTINGS);
  });
});

describe("the odds and the cost, as billing counts them", () => {
  it("shows each slot as weight over the total, to two places", () => {
    expect(oddsPercents(["30", "70"])).toEqual(["30.00", "70.00"]);
    expect(oddsPercents(["1", "2"])).toEqual(["33.33", "66.67"]);
    expect(oddsPercents(["1", "x"])).toBeNull();
  });

  it("is Σ weight × cost / Σ weight in the currency's minor units, half up", () => {
    expect(expectedCostPerSpin([{ weight: "30", costAmount: "4" }, { weight: "70", costAmount: "0" }], 2)).toBe("1.20");
    expect(expectedCostPerSpin([{ weight: "1", costAmount: "1" }, { weight: "2", costAmount: "0" }], 2)).toBe("0.33");
    expect(expectedCostPerSpin([{ weight: "1", costAmount: "0.01" }, { weight: "1", costAmount: "0" }], 2)).toBe("0.01");
    expect(expectedCostPerSpin([{ weight: "1", costAmount: "abc" }], 2)).toBeNull();
    // A toman has no minor unit: 0.33 toman a spin is told as 0, a cost of 0.5 is not one (F-116-s).
    expect(expectedCostPerSpin([{ weight: "1", costAmount: "1" }, { weight: "2", costAmount: "0" }], 0)).toBe("0");
    expect(expectedCostPerSpin([{ weight: "1", costAmount: "0.5" }], 0)).toBeNull();
  });

  it("says how many average spins the cap pays for", () => {
    expect(capLastsSpins("10", "1.20", 2)).toBe(8);
    expect(capLastsSpins("10", "0.00", 2)).toBeNull();
  });
});

describe("the form", () => {
  it("passes a wheel billing would take", () => {
    expect(validateWheelForm(form(), 2).ok).toBe(true);
  });

  it("stops a wheel whose average spin costs more than the cap, exactly as billing compares", () => {
    const v = validateWheelForm(form({ cap: "1.19" }), 2);
    expect(v.ok).toBe(false);
    expect(v.overall).toBe(WHEEL_SETTINGS_KEYS.errors.expectedOverCap);
    // Equal is allowed. (The 4.00 prize is still over a 1.20 cap: an average never passes the dearest slot.)
    expect(validateWheelForm(form({ cap: "1.20" }), 2).overall).toBeNull();
  });

  it("stops one prize that costs more than the whole cap", () => {
    const v = validateWheelForm(form({ cap: "3", prizes: [{ ...form().prizes[0], weight: "1" }, { ...form().prizes[1], weight: "1000" }] }), 2);
    expect(v.prizes[0].costAmount).toBe(WHEEL_SETTINGS_KEYS.errors.prizeOverCap);
  });

  it("holds each kind to its own shape", () => {
    const one = (p: Partial<WheelForm["prizes"][number]>) => validateWheelForm(form({ prizes: [{ ...form().prizes[0], ...p }, form().prizes[1]] }), 2).prizes[0];
    expect(one({ prizeType: "extra_days", prizeValue: "1.5" }).prizeValue).toBeDefined();
    expect(one({ prizeType: "extra_days", prizeValue: "3" })).toEqual({});
    expect(one({ prizeType: "discount_coupon", prizeValue: "20" }).couponTemplateId).toBeDefined();
    expect(one({ prizeType: "discount_coupon", prizeValue: "120", couponTemplateId: TEMPLATE, couponValidDays: "7" }).prizeValue).toBeDefined();
    expect(one({ prizeType: "discount_coupon", prizeValue: "20", couponTemplateId: TEMPLATE, couponValidDays: "7" })).toEqual({});
    expect(one({ prizeType: "free_grant", prizeValue: "0" }).variantId).toBeDefined();
    expect(one({ prizeType: "empty", costAmount: "1", prizeValue: "0" }).costAmount).toBeDefined();
    expect(one({ label: "x".repeat(PRIZE_LABEL_MAX + 1) }).label).toBeDefined();
    expect(one({ weight: "0" }).weight).toBeDefined();
  });

  it("counts the slots", () => {
    expect(validateWheelForm(form({ prizes: [form().prizes[0]] }), 2).overall).toBe(WHEEL_SETTINGS_KEYS.errors.tooFewPrizes);
    expect(validateWheelForm(form({ prizes: Array(PRIZES_MAX + 1).fill(form().prizes[1]) }), 2).overall).toBe(WHEEL_SETTINGS_KEYS.errors.tooManyPrizes);
  });

  it("sends the schema's keys only, each prize with its kind's fields and no other", () => {
    const body = wheelVersionBody(
      form({ minPaid: "50", userGroupId: TEMPLATE, prizes: [{ ...form().prizes[0], couponTemplateId: TEMPLATE, couponValidDays: "7", dailyStockLimit: "5" }, form().prizes[1]] }),
    );
    expect(Object.keys(body).sort()).toEqual(
      [
        "isActive",
        "dailyBudgetCapAmount",
        "perUserCooldownHours",
        "maxSpinsPerAccountPerDay",
        "requiresMinAccountAgeHours",
        "requiresMinTotalPurchaseAmount",
        "requiresMinCompletedOrdersCount",
        "requiresActiveServiceAtSpinTime",
        "requiresPhoneVerified",
        "userGroupId",
        "prizes",
      ].sort(),
    );
    expect(body).toMatchObject({ dailyBudgetCapAmount: "10", requiresMinTotalPurchaseAmount: "50", requiresMinCompletedOrdersCount: null, userGroupId: TEMPLATE, maxSpinsPerAccountPerDay: 1 });
    expect(body.prizes[0]).toEqual({
      label: "1 GB",
      prizeType: "bonus_traffic_gb",
      prizeValue: "1",
      couponTemplateId: null,
      couponValidDays: null,
      variantId: null,
      weight: 30,
      costAmount: "4",
      dailyStockLimit: 5,
    });
  });

  it("opens on the version it edits, so a save restates what is not changed", () => {
    const v: WheelVersion = {
      id: "v",
      version: 3,
      effectiveFromDay: "2026-10-04",
      isActive: true,
      dailyBudgetCapAmount: "10.00",
      currencyCode: "USD",
      perUserCooldownHours: 12,
      maxSpinsPerAccountPerDay: 2,
      requiresMinAccountAgeHours: 24,
      requiresMinTotalPurchaseAmount: null,
      requiresMinCompletedOrdersCount: 1,
      requiresActiveServiceAtSpinTime: false,
      requiresPhoneVerified: true,
      userGroupId: null,
      createdByAdminId: "a",
      createdAt: "2026-10-03T00:00:00Z",
      expectedCostPerSpin: "1.20",
      prizes: [
        { id: "p1", position: 1, label: "1 GB", prizeType: "bonus_traffic_gb", prizeValue: "1.00", couponTemplateId: null, couponValidDays: null, variantId: null, weight: 30, costAmount: "4.00", dailyStockLimit: null },
        { id: "p2", position: 2, label: "Nothing", prizeType: "empty", prizeValue: "0.00", couponTemplateId: null, couponValidDays: null, variantId: null, weight: 70, costAmount: "0.00", dailyStockLimit: null },
      ],
    };
    const body = wheelVersionBody(formFromVersion(v));
    expect(body).toMatchObject({ dailyBudgetCapAmount: "10.00", perUserCooldownHours: 12, maxSpinsPerAccountPerDay: 2, requiresMinCompletedOrdersCount: 1, requiresActiveServiceAtSpinTime: false });
    expect(body.prizes.map((p) => [p.label, p.weight, p.costAmount])).toEqual([
      ["1 GB", 30, "4.00"],
      ["Nothing", 70, "0.00"],
    ]);
  });
});

describe("every key this page can reach", () => {
  const flatten = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(flatten) : []);
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
    expect(flatten(WHEEL_SETTINGS_KEYS).filter((k) => !keys.has(k))).toEqual([]);
  });
});
