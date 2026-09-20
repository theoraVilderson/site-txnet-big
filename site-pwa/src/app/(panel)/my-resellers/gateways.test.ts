import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PANEL_GATEWAYS, PANEL_MY_RESELLERS, myResellerGatewaysPath } from "@/lib/routes";
import { gatewayApiPrefix } from "@/lib/billing-api";
import { createBody, emptyForm, surfaceActor } from "../gateways/_lib/gateway-form";
import { GATEWAY_REFUSAL_KEYS, gatewayRefusalKey } from "./_lib/gateways";
import { stepHref } from "./_lib/onboarding";

/**
 * A reseller's gateways, `/my-resellers/[id]/gateways` (F-066-w4, ADR-0064 (4)).
 * The screen is the ambient page's components over the reseller route built by
 * F-066-w3, so what breaks with nothing red anywhere is the seam between them:
 *  - **a call that leaves out the reseller.** The ambient `/gateways` configures
 *    the session's tenant — the platform owner's, for the visitor this screen is
 *    for (ADR-0059) — so a path built without `/tenants/:id` configures the
 *    wrong tenant and answers 200 while doing it;
 *  - **an elevated body.** The reseller route's schema is `.strict()` and the
 *    work runs as the reseller: a `tenantId` or a `verificationStatus` that the
 *    platform staff's own session would add is refused, so the form is handed an
 *    actor with no owner powers whoever is signed in;
 *  - **a refusal with no sentence.** Both doors' reasons are read from the
 *    controller's own exhaustive `STATUS` map, so one added there fails here
 *    instead of reaching a reseller's owner as a blank line;
 *  - **the console's gateway step linking nothing**, which is what it did until
 *    this row, or linking the ambient page.
 */
const REPO = join(__dirname, "../../../../..");
const CONTROLLER = "txnet-backend/billing-service/src/app/payment/gateway-admin/reseller-gateway.controller.ts";

describe("the route the screen calls", () => {
  it("names the reseller in the path, never the session's tenant", () => {
    expect(gatewayApiPrefix(null)).toBe("/gateways");
    expect(gatewayApiPrefix("t-1")).toBe("/tenants/t-1/gateways");
    expect(gatewayApiPrefix("a b/c")).toBe("/tenants/a%20b%2Fc/gateways");
  });

  it("is a path the controller serves", () => {
    const source = readFileSync(join(REPO, CONTROLLER), "utf8");
    expect(source).toContain("@Controller('billing/tenants/:tenantId/gateways')");
  });
});

describe("what a write may carry", () => {
  it("elevates nothing on a reseller's screen", () => {
    const form = {
      ...emptyForm("tenant"),
      displayName: "Zarinpal",
      providerName: "zarinpal",
      gatewayCategory: "domestic_rial",
      tenantId: "t-other",
      verificationStatus: "verified",
    };
    const owner = { tenant: { type: "platform_owner" } } as never;
    // The same platform staff member, on the two surfaces.
    expect(createBody(form, surfaceActor(owner, null))).toMatchObject({ tenantId: "t-other", verificationStatus: "verified" });
    const scoped = createBody(form, surfaceActor(owner, "t-1"));
    expect(scoped).not.toHaveProperty("tenantId");
    expect(scoped).not.toHaveProperty("verificationStatus");
  });
});

describe("what the reseller's gateway routes can refuse", () => {
  it("has a sentence for every reason, both doors' included", () => {
    const map = /const STATUS: Record<ResellerGatewayRejection, [^>]*> = \{([\s\S]*?)\n\};/.exec(readFileSync(join(REPO, CONTROLLER), "utf8"));
    if (!map) throw new Error("the controller no longer maps every reason to a status — this test is stale");
    const reasons = [...map[1].matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(10);
    expect(Object.keys(GATEWAY_REFUSAL_KEYS).sort()).toEqual([...new Set(reasons)].sort());
  });

  it("names the refusal it knows and nothing else", () => {
    expect(gatewayRefusalKey({ reason: "reseller_suspended" })).toBe(GATEWAY_REFUSAL_KEYS.reseller_suspended);
    expect(gatewayRefusalKey({ reason: "gateway_has_open_payments" })).toBe(GATEWAY_REFUSAL_KEYS.gateway_has_open_payments);
    expect(gatewayRefusalKey({ reason: "domain_taken" })).toBeNull();
    expect(gatewayRefusalKey(new Error("offline"))).toBeNull();
  });
});

describe("the workspace path", () => {
  it("builds the path the app actually serves", () => {
    expect(myResellerGatewaysPath("t-1")).toBe(`${PANEL_MY_RESELLERS}/t-1/gateways`);
    expect(myResellerGatewaysPath("a b/c")).toBe(`${PANEL_MY_RESELLERS}/a%20b%2Fc/gateways`);
    expect(existsSync(join(__dirname, "[id]", "gateways", "page.tsx"))).toBe(true);
  });

  it("is where the console's gateway step goes, and the ambient page is not", () => {
    expect(stepHref("gateway", "t-1")).toBe(myResellerGatewaysPath("t-1"));
    expect(stepHref("gateway", "t-1")).not.toBe(PANEL_GATEWAYS);
    expect(stepHref("pricing", "t-1")).toBeNull();
  });
});
