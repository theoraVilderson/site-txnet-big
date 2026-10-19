import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RealtimeEvents } from "@/generated/wire";
import { manualQueuePrefix } from "@/lib/billing-api";
import { userChannel, tenantChannel } from "@/lib/realtime";
import { myResellerPaymentsPath } from "@/lib/routes";
import { manualLiveOf } from "../payments/manual/_lib/manual-live";
import { RESELLER_MENU } from "../_lib/reseller-menu";

/**
 * A reseller's payments to confirm (F-093-w over F-093-v): the manual-payments
 * screen for the reseller the address names. What breaks with nothing red:
 *  - **a call that leaves out the reseller.** The owner signs in to the
 *    platform's tenant (ADR-0059), so the ambient queue is the platform's — or,
 *    holding no key, a 403 that reads as "nothing to confirm";
 *  - **no way in.** The page is reached from the reseller button only;
 *  - **a page that never moves.** The owner hears the reseller's payments on
 *    their own `user:` channel, and only this reseller's re-read the page.
 */
const REPO = join(__dirname, "../../../../..");
const CONTROLLER = "txnet-backend/billing-service/src/app/payment/deposit/reseller-manual-confirm.controller.ts";

describe("the route the screen calls", () => {
  it("names the reseller in the path, and the session's queue only without one", () => {
    expect(manualQueuePrefix(null)).toBe("/payments/manual");
    expect(manualQueuePrefix("t-1")).toBe("/tenants/t-1/payments/manual");
    expect(manualQueuePrefix("a b/c")).toBe("/tenants/a%20b%2Fc/payments/manual");
  });

  it("is a path the controller serves", () => {
    const source = readFileSync(join(REPO, CONTROLLER), "utf8");
    expect(source).toContain("@Controller('billing/tenants/:tenantId/payments/manual')");
  });
});

describe("the way in", () => {
  it("is a row under the reseller button, for a seat holding the key", () => {
    const row = RESELLER_MENU.find((r) => r.id === "reseller-payments");
    expect(row).toMatchObject({ key: "payment.confirm_manual" });
    expect(row?.href("t-1", false)).toBe(myResellerPaymentsPath("t-1"));
    expect(row?.href("t-1", true)).toBe(myResellerPaymentsPath("t-1", true));
  });
});

describe("what the page listens to", () => {
  const owner = { userId: "u-owner", tenant: { id: "platform" }, permissions: ["realtime.tenant.read"] };

  it("hears the owner's own channel, for this reseller only", () => {
    const [mine] = manualLiveOf(owner, "t-1");
    expect(mine).toMatchObject({ channel: userChannel("u-owner"), types: [RealtimeEvents.paymentResellerOpenChanged] });
    expect(mine.accepts?.({ resellerId: "t-1" })).toBe(true);
    expect(mine.accepts?.({ resellerId: "t-2" })).toBe(false);
  });

  it("hears the session's tenant too: the platform's staff, or a seat on its own reseller", () => {
    expect(manualLiveOf(owner, "t-1")[1]).toMatchObject({ channel: tenantChannel("platform"), types: [RealtimeEvents.paymentOpenChanged] });
    const seat = { userId: "u-seat", tenant: { id: "t-1" }, permissions: ["realtime.tenant.read"] };
    expect(manualLiveOf(seat, "t-1")).toEqual([{ channel: tenantChannel("t-1"), types: [RealtimeEvents.paymentOpenChanged] }]);
  });

  it("is the session's own queue without a reseller", () => {
    expect(manualLiveOf(owner, null)).toEqual([{ channel: tenantChannel("platform"), types: [RealtimeEvents.paymentOpenChanged] }]);
  });
});
