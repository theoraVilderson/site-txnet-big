import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Me } from "@/lib/auth-api";
import type { OwnedReseller, PackageOffer } from "@/lib/tenant-api";
import { PANEL_HOME, PANEL_RESELLERS, PANEL_RESELLER_PURCHASE } from "@/lib/routes";
import { PANEL_MENU, menuHrefs, visibleMenu } from "../_lib/panel-menu";
import {
  PURCHASE_REFUSAL_KEYS,
  canBuyReseller,
  emptyPurchaseForm,
  isInsufficientBalance,
  offerChoices,
  offerPrice,
  ownedHosts,
  purchaseBody,
  suggestibleName,
  validatePurchase,
  type PurchaseForm,
} from "./_lib/purchase";

/**
 * A platform user buys a reseller (F-019-i). What breaks with nothing red:
 *  - **a refusal with no sentence.** The purchase sends a `reason`; every one
 *    of them is read out of tenant-service's own closed union, so a reason
 *    added there fails here rather than reaching a buyer as a blank alert;
 *  - **the page offered to the wrong visitor.** This is not the owner's
 *    administration: it needs no permission key, and a reseller's own user is
 *    not a platform user — `not_platform_user` is the service's boundary, and
 *    the menu must not invite someone into it;
 *  - **a body the `.strict()` schema refuses** — an empty `slug` sent as `""`,
 *    a name past 100, a package with no price for the chosen period.
 */
const REPO = join(__dirname, "../../../../..");
const read = (path: string) => readFileSync(join(REPO, "txnet-backend", path), "utf8");

function unionOf(file: string, name: string): string[] {
  const union = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(read(file));
  if (!union) throw new Error(`${name} is no longer a literal union — this test is stale`);
  return [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const BUYER: Me = {
  userId: "u1",
  fullName: "Theora",
  role: { id: "r1", name: "User" },
  permissions: [],
  tenant: { id: "t-owner", type: "platform_owner", isOwner: false },
  email: null,
  isImpersonated: false,
};
const OWNER: Me = { ...BUYER, permissions: ["*"] };
const RESELLER_USER: Me = { ...BUYER, tenant: { id: "t-res", type: "reseller", isOwner: true } };

describe("what the purchase can refuse", () => {
  it("has a sentence for every reason", () => {
    const reasons = unionOf("tenant-service/src/app/purchase/reseller-purchase.service.ts", "PurchaseRejection");
    expect(Object.keys(PURCHASE_REFUSAL_KEYS).sort()).toEqual([...reasons].sort());
  });

  it("knows the one refusal that points at the top-up", () => {
    expect(isInsufficientBalance({ reason: "insufficient_balance" })).toBe(true);
    expect(isInsufficientBalance({ reason: "slug_taken" })).toBe(false);
    expect(isInsufficientBalance(new Error("offline"))).toBe(false);
  });
});

describe("who may buy", () => {
  it("is any user of the platform owner's tenant, with no permission key", () => {
    expect(canBuyReseller(BUYER)).toBe(true);
    expect(canBuyReseller(OWNER)).toBe(true);
    expect(canBuyReseller(RESELLER_USER)).toBe(false);
    expect(canBuyReseller(null)).toBe(false);
  });

  it("shows the menu entry to a platform user who may not administer resellers", () => {
    const hrefs = (me: Me) => menuHrefs(visibleMenu(PANEL_MENU, me.permissions, me.tenant.type, me.tenant.isOwner, false));
    expect(hrefs(BUYER)).toContain(PANEL_RESELLER_PURCHASE);
    expect(hrefs(BUYER)).not.toContain(PANEL_RESELLERS);
    expect(hrefs(RESELLER_USER)).not.toContain(PANEL_RESELLER_PURCHASE);
  });

  // F-114-c. The entry invites a purchase; it is not offered to the account
  // that owns the platform, nor to a buyer who already owns a reseller — the
  // sidebar's own "my reseller panel" is that buyer's way in.
  it("is not offered to the platform's owner, nor to a user who owns a reseller", () => {
    const hrefs = (me: Me, ownsReseller: boolean | null) =>
      menuHrefs(visibleMenu(PANEL_MENU, me.permissions, me.tenant.type, me.tenant.isOwner, ownsReseller));
    const PLATFORM_OWNER: Me = { ...OWNER, tenant: { ...OWNER.tenant, isOwner: true } };
    expect(hrefs(BUYER, false)).toContain(PANEL_RESELLER_PURCHASE);
    expect(hrefs(BUYER, true)).not.toContain(PANEL_RESELLER_PURCHASE);
    expect(hrefs(PLATFORM_OWNER, false)).not.toContain(PANEL_RESELLER_PURCHASE);
    expect(hrefs(PLATFORM_OWNER, false)).toContain(PANEL_RESELLERS);
    // Until the list answers, it is not shown — the safe direction, as for `me`.
    expect(hrefs(BUYER, null)).not.toContain(PANEL_RESELLER_PURCHASE);
    // Nothing else hangs on the list.
    expect(hrefs(BUYER, null)).toContain(PANEL_HOME);
  });

  it("is highlighted over the administration entry, which is its path's prefix", () => {
    expect(PANEL_RESELLER_PURCHASE.startsWith(`${PANEL_RESELLERS}/`)).toBe(true);
    expect(PANEL_RESELLER_PURCHASE.length).toBeGreaterThan(PANEL_RESELLERS.length);
  });
});

describe("the packages on sale", () => {
  const offer = (id: string, over: Partial<PackageOffer> = {}): PackageOffer => ({
    id,
    name: id,
    monthlyPrice: "10",
    yearlyPrice: "100",
    includedFeatureKeys: [],
    ...over,
  });
  const all = [offer("basic"), offer("monthly-only", { yearlyPrice: null })];

  it("offers only a package priced for the period", () => {
    expect(offerChoices(all, "subscription_yearly").map((p) => p.id)).toEqual(["basic"]);
    expect(offerChoices(all, "subscription_monthly").map((p) => p.id)).toEqual(["basic", "monthly-only"]);
  });

  it("reads the period's own price", () => {
    expect(offerPrice(all[0], "subscription_yearly")).toBe("100");
    expect(offerPrice(all[1], "subscription_yearly")).toBeNull();
  });
});

describe("buying", () => {
  const valid: PurchaseForm = { ...emptyPurchaseForm(), packageId: "p1", name: "Acme VPN" };

  it("sends the slug only when the buyer kept one", () => {
    expect(validatePurchase(valid)).toEqual({});
    expect(purchaseBody(valid)).toEqual({ packageId: "p1", billingModel: "subscription_monthly", name: "Acme VPN" });
    expect(purchaseBody({ ...valid, name: "  Acme VPN  ", slug: " Acme-VPN " })).toEqual({
      packageId: "p1",
      billingModel: "subscription_monthly",
      name: "Acme VPN",
      slug: "acme-vpn",
    });
  });

  it.each([
    [{ packageId: "" }, "packageId"],
    [{ name: "" }, "name"],
    [{ name: "a".repeat(101) }, "name"],
    [{ slug: "-acme" }, "slug"],
    [{ slug: "acme_vpn" }, "slug"],
    [{ slug: "panel" }, "slug"],
  ])("refuses %o on %s", (patch, field) => {
    expect(validatePurchase({ ...valid, ...patch })).toHaveProperty(field);
  });

  it("asks for a suggestion only for a name the slug route would take", () => {
    expect(suggestibleName(" Acme VPN ")).toBe("Acme VPN");
    expect(suggestibleName("   ")).toBeNull();
    expect(suggestibleName("a".repeat(101))).toBeNull();
  });
});

describe("a buyer who already holds one (F-019-l)", () => {
  const domain = (domainValue: string, domainType: string, purpose: string, verificationStatus: string) => ({
    domainValue,
    domainType,
    purpose,
    verificationStatus,
  });
  const held: OwnedReseller = {
    id: "r1",
    slug: "ali-vpn",
    status: "active",
    billingModel: "subscription_monthly",
    package: { id: "p1", name: "Pro" },
    currentPeriodEnd: "2026-10-18T10:00:00.000Z",
    domains: [
      domain("ali-vpn.edge.txnet.app", "subdomain", "panel", "pending"),
      domain("pending.ali.ir", "custom_domain", "panel", "verifying"),
      domain("sub.ali.ir", "custom_domain", "subscription", "verified"),
      domain("panel.ali.ir", "custom_domain", "panel", "verified"),
    ],
  };

  it("names only a proved panel domain as the address — never the CNAME target, which opens nothing", () => {
    expect(ownedHosts(held)).toEqual({ panel: "panel.ali.ir", target: "ali-vpn.edge.txnet.app" });
  });

  it("has no address until a panel domain is proved, and still says where to point one", () => {
    const fresh = { ...held, domains: held.domains.filter((d) => d.domainValue !== "panel.ali.ir") };
    expect(ownedHosts(fresh)).toEqual({ panel: null, target: "ali-vpn.edge.txnet.app" });
  });

  it("reads the route the page asks before the form: the service's own `/purchase/mine`", () => {
    const api = readFileSync(join(__dirname, "../../../lib/tenant-api.ts"), "utf8");
    expect(api).toMatch(/"\/tenants\/purchase\/mine"/);
    expect(read("tenant-service/src/app/purchase/reseller-purchase.controller.ts")).toMatch(/@Get\('mine'\)/);
  });
});
