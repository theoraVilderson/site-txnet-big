import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PANEL_CATALOG, PANEL_MY_RESELLERS, myResellerCatalogPath, myResellerCatalogTranslationsPath } from "@/lib/routes";
import { catalogApiPrefix } from "@/lib/catalog-api";
import { categoryBody, emptyCategoryForm, emptyProductForm, isPlatformOwner, productBody, surfaceActor } from "../catalog/_lib/catalog-form";
import { CATALOG_REFUSAL_KEYS, catalogRefusalKey } from "./_lib/catalog";
import { stepHref } from "./_lib/onboarding";

/**
 * A reseller's catalog, `/my-resellers/[id]/catalog` (F-066-w8, ADR-0064 (4)).
 * The screen is the ambient page's components over the reseller route built by
 * F-066-w7, so what breaks with nothing red anywhere is the seam between them:
 *  - **a call that leaves out the reseller.** The ambient `/catalog` manages the
 *    session's tenant — the platform owner's, for the visitor this screen is for
 *    (ADR-0059) — so a path built without `/tenants/:id` prices the wrong
 *    catalog and answers 200 while doing it;
 *  - **an elevated body.** The reseller route's schema is `.strict()` and
 *    nothing is elevated there: a `tenantId` that the platform staff's own
 *    session would add is refused, so the forms are handed an actor with no
 *    owner powers whoever is signed in;
 *  - **a refusal with no sentence.** Both doors' reasons are read from the
 *    controller's own exhaustive `STATUS` map, so one added there fails here
 *    instead of reaching a reseller's owner as a blank line;
 *  - **the console's pricing step linking nothing**, which is what it did until
 *    this row, or linking the ambient page.
 */
const REPO = join(__dirname, "../../../../..");
const CONTROLLER = "txnet-backend/billing-service/src/app/catalog/reseller-catalog.controller.ts";

describe("the route the screen calls", () => {
  it("names the reseller in the path, never the session's tenant", () => {
    expect(catalogApiPrefix(null)).toBe("");
    expect(catalogApiPrefix("t-1")).toBe("/tenants/t-1");
    expect(catalogApiPrefix("a b/c")).toBe("/tenants/a%20b%2Fc");
  });

  it("is a path the controller serves", () => {
    const source = readFileSync(join(REPO, CONTROLLER), "utf8");
    expect(source).toContain("@Controller('catalog/tenants/:tenantId')");
  });
});

describe("what a write may carry", () => {
  it("elevates nothing on a reseller's screen", () => {
    const owner = { tenant: { type: "platform_owner" } } as never;
    const form = { ...emptyProductForm("fa"), categoryId: "c-1", key: "vpn_pro", name: "VPN Pro", owner: "tenant" as const, tenantId: "t-other" };

    // The same platform staff member, on the two surfaces.
    expect(productBody(form, surfaceActor(owner, null))).toMatchObject({ tenantId: "t-other" });
    expect(productBody(form, surfaceActor(owner, "t-1"))).not.toHaveProperty("tenantId");

    // A shared category is the platform's, so it is not offered here either.
    const shared = { ...emptyCategoryForm("fa"), key: "vpn", name: "VPN", shared: true };
    expect(categoryBody(shared, isPlatformOwner(surfaceActor(owner, null)))).toMatchObject({ tenantId: null });
    expect(categoryBody(shared, isPlatformOwner(surfaceActor(owner, "t-1")))).not.toHaveProperty("tenantId");
  });
});

describe("what the reseller's catalog routes can refuse", () => {
  it("has a sentence for every reason, both doors' included", () => {
    const map = /const STATUS: Record<ResellerCatalogRejection, [^>]*> = \{([\s\S]*?)\n\};/.exec(readFileSync(join(REPO, CONTROLLER), "utf8"));
    if (!map) throw new Error("the controller no longer maps every reason to a status — this test is stale");
    const reasons = [...map[1].matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(10);
    expect(Object.keys(CATALOG_REFUSAL_KEYS).sort()).toEqual([...new Set(reasons)].sort());
  });

  it("names the refusal it knows and nothing else", () => {
    expect(catalogRefusalKey({ reason: "reseller_suspended" })).toBe(CATALOG_REFUSAL_KEYS.reseller_suspended);
    expect(catalogRefusalKey({ reason: "price_in_the_past" })).toBe(CATALOG_REFUSAL_KEYS.price_in_the_past);
    expect(catalogRefusalKey({ reason: "domain_taken" })).toBeNull();
    expect(catalogRefusalKey(new Error("offline"))).toBeNull();
  });
});

describe("the workspace path", () => {
  it("builds the paths the app actually serves", () => {
    expect(myResellerCatalogPath("t-1")).toBe(`${PANEL_MY_RESELLERS}/t-1/catalog`);
    expect(myResellerCatalogPath("a b/c")).toBe(`${PANEL_MY_RESELLERS}/a%20b%2Fc/catalog`);
    expect(myResellerCatalogTranslationsPath("t-1")).toBe(`${PANEL_MY_RESELLERS}/t-1/catalog/translations`);
    expect(existsSync(join(__dirname, "[id]", "catalog", "page.tsx"))).toBe(true);
    expect(existsSync(join(__dirname, "[id]", "catalog", "translations", "page.tsx"))).toBe(true);
  });

  it("is where the console's pricing step goes, and the ambient page is not", () => {
    expect(stepHref("pricing", "t-1")).toBe(myResellerCatalogPath("t-1"));
    expect(stepHref("pricing", "t-1")).not.toBe(PANEL_CATALOG);
  });
});
