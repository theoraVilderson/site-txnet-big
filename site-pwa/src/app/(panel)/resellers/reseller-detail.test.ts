import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Me } from "@/lib/auth-api";
import { PANEL_RESELLERS, panelResellerPath } from "@/lib/routes";
import {
  RESELLER_TABS,
  canReadTenantLedger,
  resellerTab,
  resellerTabs,
} from "./_lib/resellers";

/**
 * One reseller's page, `/resellers/[id]` (F-019-k). What breaks with nothing
 * red anywhere:
 *  - **a ledger tab offered to someone billing refuses.** The read is its own
 *    key (`tenant_billing.read`, F-019-j), held apart from the adjustment's;
 *    the key is read out of billing-service so a rename there is caught here;
 *  - **a `?tab=` that is not a tab**, or one this visitor may not open — the
 *    page falls back to the first tab it will actually render;
 *  - **a link to a path Next does not serve.** The list opens this page by
 *    {@link panelResellerPath}, so the constant and the route folder are held
 *    together.
 */
const REPO = join(__dirname, "../../../../..");
const read = (path: string) => readFileSync(join(REPO, "txnet-backend", path), "utf8");

const OWNER: Me = {
  userId: "u1",
  fullName: "Theora",
  role: { id: "r1", name: "SuperAdmin" },
  permissions: ["*"],
  tenant: { id: "t-owner", type: "platform_owner", isOwner: false },
  email: null,
  isImpersonated: false,
};
const SUPPORT: Me = { ...OWNER, role: { id: "r3", name: "Support" }, permissions: ["tenant.manage", "tenant_billing.read"] };
const ADJUSTER: Me = { ...OWNER, role: { id: "r4", name: "Admin" }, permissions: ["tenant.manage", "tenant_billing.adjust"] };
const PLAIN: Me = { ...OWNER, role: { id: "r5", name: "Support" }, permissions: ["tenant.manage"] };
const RESELLER: Me = { ...OWNER, permissions: ["*"], tenant: { id: "t-res", type: "reseller", isOwner: true } };

describe("the reseller's page and the list that opens it", () => {
  it("builds the path the app actually serves", () => {
    expect(panelResellerPath("t-1")).toBe(`${PANEL_RESELLERS}/t-1`);
    expect(panelResellerPath("a b/c")).toBe(`${PANEL_RESELLERS}/a%20b%2Fc`);
    expect(existsSync(join(__dirname, "[id]", "page.tsx"))).toBe(true);
  });
});

describe("the ledger tab's key (F-019-j)", () => {
  it("is the one billing-service gates the read on, on the platform owner's tenant only", () => {
    expect(read("billing-service/src/app/tenant-billing/tenant-billing-admin.controller.ts")).toContain(
      "export const TENANT_BILLING_READ = 'tenant_billing.read'",
    );
    expect(canReadTenantLedger(OWNER)).toBe(true);
    expect(canReadTenantLedger(SUPPORT)).toBe(true);
    expect(canReadTenantLedger(ADJUSTER)).toBe(false);
    expect(canReadTenantLedger({ ...RESELLER, permissions: ["tenant_billing.read"] })).toBe(false);
  });
});

describe("which tabs a visitor is offered", () => {
  it("adds billing for a reader, for an adjuster, and for neither", () => {
    expect(resellerTabs(OWNER)).toEqual([...RESELLER_TABS]);
    expect(resellerTabs(SUPPORT)).toContain("billing");
    expect(resellerTabs(ADJUSTER)).toContain("billing");
    expect(resellerTabs(PLAIN)).toEqual(["overview"]);
  });

  it("falls back to the first tab it will render", () => {
    expect(resellerTab("billing", resellerTabs(OWNER))).toBe("billing");
    expect(resellerTab("billing", resellerTabs(PLAIN))).toBe("overview");
    expect(resellerTab(null, resellerTabs(OWNER))).toBe("overview");
    expect(resellerTab("statistics", resellerTabs(OWNER))).toBe("overview");
  });
});
