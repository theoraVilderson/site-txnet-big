import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Me } from "@/lib/auth-api";
import type { TenantPackage } from "@/lib/tenant-api";
import { PANEL_RESELLERS } from "@/lib/routes";
import { PANEL_MENU, menuHrefs, visibleMenu } from "../_lib/panel-menu";
import {
  BILLING_MODELS,
  REFUSAL_KEYS,
  RESERVED_SLUGS,
  adjustBody,
  canAdjustWallet,
  canAdministerResellers,
  createBody,
  packageChoices,
  statusChoices,
  validateAdjust,
  validateCreate,
} from "./_lib/resellers";

/**
 * The platform owner's reseller administration (F-018-k). What breaks with
 * nothing red anywhere:
 *  - **a refusal with no sentence.** tenant-service and billing send a
 *    `reason`; every reason the four services behind this page can send has a
 *    line, read out of each service's own closed union;
 *  - **a choice the service refuses** — a period it does not sell, a reserved
 *    slug, a status that cannot be set (`trial`, or anything on a terminated
 *    reseller), a package with no price for the period;
 *  - **the menu entry shown to a reseller.** A reseller administers its own
 *    roles and can grant itself `tenant.manage`, so the key alone is not enough
 *    (`panel-menu.ts`): the entry names the platform owner's tenant type too.
 */
const REPO = join(__dirname, "../../../../..");
const read = (path: string) => readFileSync(join(REPO, "txnet-backend", path), "utf8");

function unionOf(file: string, name: string): string[] {
  const union = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(read(file));
  if (!union) throw new Error(`${name} is no longer a literal union — this test is stale`);
  return [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const OWNER: Me = {
  userId: "u1",
  fullName: "Theora",
  role: { id: "r1", name: "SuperAdmin" },
  permissions: ["*"],
  tenant: { id: "t-owner", type: "platform_owner", isOwner: false },
  email: null,
  isImpersonated: false,
};
const OWNER_STAFF: Me = { ...OWNER, role: { id: "r3", name: "Support" }, permissions: ["tenant.manage"] };
const RESELLER: Me = { ...OWNER, role: { id: "r2", name: "Admin" }, permissions: ["tenant.manage", "tenant_billing.adjust"], tenant: { id: "t-res", type: "reseller", isOwner: true } };
const UUID = "22222222-2222-4222-8222-222222222222";

describe("what the services behind this page can refuse", () => {
  it("has a sentence for every reason", () => {
    const reasons = new Set([
      ...unionOf("tenant-service/src/app/resellers/reseller.service.ts", "ResellerRejection"),
      ...unionOf("tenant-service/src/app/subscription/tenant-subscription.service.ts", "TenantSubscriptionRejection"),
      ...unionOf("tenant-service/src/app/status/tenant-status.service.ts", "TenantStatusRejection"),
      ...unionOf("billing-service/src/app/tenant-billing/tenant-billing-admin.service.ts", "TenantBillingAdminRejection"),
    ]);
    expect(Object.keys(REFUSAL_KEYS).sort()).toEqual([...reasons].sort());
  });

  it("offers exactly the periods the create schema takes, and reserves the same slugs", () => {
    const schema = read("tenant-service/src/app/resellers/reseller.schema.ts");
    const models = /BILLING_MODELS = \[([^\]]*)\]/.exec(schema)?.[1] ?? "";
    expect([...BILLING_MODELS].sort()).toEqual([...models.matchAll(/TenantBillingModel\.([a-z_]+)/g)].map((m) => m[1]).sort());
    const reserved = /RESERVED_SLUGS = \[([^\]]*)\]/.exec(schema)?.[1] ?? "";
    expect([...RESERVED_SLUGS].sort()).toEqual([...reserved.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort());
  });
});

describe("who sees the page", () => {
  it("is the platform owner's tenant holding tenant.manage, never a reseller", () => {
    expect(canAdministerResellers(OWNER)).toBe(true);
    expect(canAdministerResellers(OWNER_STAFF)).toBe(true);
    expect(canAdministerResellers(RESELLER)).toBe(false);
    expect(canAdministerResellers({ ...OWNER, permissions: ["catalog.manage"] })).toBe(false);
    expect(canAdministerResellers(null)).toBe(false);
  });

  it("puts the menu entry behind the same two conditions", () => {
    const hrefs = (me: Me) => menuHrefs(visibleMenu(PANEL_MENU, me.permissions, me.tenant.type, me.tenant.isOwner));
    expect(hrefs(OWNER)).toContain(PANEL_RESELLERS);
    expect(hrefs(OWNER_STAFF)).toContain(PANEL_RESELLERS);
    expect(hrefs(RESELLER)).not.toContain(PANEL_RESELLERS);
  });

  it("offers the wallet adjustment only with tenant_billing.adjust, on the platform owner's tenant", () => {
    expect(canAdjustWallet(OWNER)).toBe(true);
    expect(canAdjustWallet(OWNER_STAFF)).toBe(false);
    expect(canAdjustWallet(RESELLER)).toBe(false);
  });
});

describe("creating a reseller", () => {
  const valid = { slug: "acme-vpn", billingModel: "subscription_monthly" as const, ownerUserId: UUID };

  it("sends exactly the three fields the strict schema takes", () => {
    expect(validateCreate(valid)).toEqual({});
    expect(createBody({ ...valid, slug: "  Acme-VPN " })).toEqual({ ...valid, slug: "acme-vpn" });
  });

  it.each([
    [{ slug: "" }, "slug"],
    [{ slug: "-acme" }, "slug"],
    [{ slug: "acme_vpn" }, "slug"],
    [{ slug: "a".repeat(64) }, "slug"],
    [{ slug: "panel" }, "slug"],
    [{ ownerUserId: "someone" }, "ownerUserId"],
    [{ billingModel: "" }, "billingModel"],
  ])("refuses %o on %s", (patch, field) => {
    expect(validateCreate({ ...valid, ...patch } as typeof valid)).toHaveProperty(field);
  });
});

describe("package and period", () => {
  const pkg = (id: string, over: Partial<TenantPackage> = {}): TenantPackage => ({
    id,
    name: id,
    monthlyPrice: "10",
    yearlyPrice: "100",
    includedFeatureKeys: [],
    isActive: true,
    ...over,
  });
  const all = [pkg("basic"), pkg("monthly-only", { yearlyPrice: null }), pkg("retired", { isActive: false })];

  it("offers only packages priced for the period", () => {
    expect(packageChoices(all, "subscription_yearly", null).map((p) => p.id)).toEqual(["basic"]);
    expect(packageChoices(all, "subscription_monthly", null).map((p) => p.id)).toEqual(["basic", "monthly-only"]);
  });

  it("keeps an inactive package for the reseller already on it, and for no one else", () => {
    expect(packageChoices(all, "subscription_monthly", "retired").map((p) => p.id)).toContain("retired");
  });
});

describe("status", () => {
  it("never offers trial, and nothing once terminated", () => {
    expect(statusChoices("trial")).toEqual(["active", "suspended", "terminated"]);
    expect(statusChoices("active")).toEqual(["suspended", "terminated"]);
    expect(statusChoices("terminated")).toEqual([]);
  });

  it("offers suspended again on a suspended reseller — the way a non-payment suspension becomes a manual one", () => {
    expect(statusChoices("suspended")).toEqual(["active", "suspended", "terminated"]);
  });
});

describe("adjusting the billing wallet", () => {
  it("takes a positive decimal of at most two places and a note of at most 500", () => {
    expect(validateAdjust({ direction: "credit", amount: "250.50", note: "" })).toEqual({});
    for (const amount of ["", "0", "0.00", "-1", "1.234", "1e3", "01"]) {
      expect(validateAdjust({ direction: "credit", amount, note: "" }), amount).toHaveProperty("amount");
    }
    expect(validateAdjust({ direction: "debit", amount: "1", note: "x".repeat(501) })).toHaveProperty("note");
  });

  it("sends the request id it was given, and no empty note", () => {
    expect(adjustBody({ direction: "debit", amount: " 5 ", note: "  " }, UUID)).toEqual({ direction: "debit", amount: "5", requestId: UUID });
    expect(adjustBody({ direction: "credit", amount: "5", note: " refund " }, UUID)).toEqual({ direction: "credit", amount: "5", requestId: UUID, note: "refund" });
  });
});
