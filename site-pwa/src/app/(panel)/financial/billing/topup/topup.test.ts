import { describe, expect, it } from "vitest";
import type { DepositGateway } from "@/lib/billing-api";
import { topupBody } from "./_lib/topup";

/**
 * A reseller's billing top-up page (F-019-e, ADR-0056), and the one thing
 * about it that has to be true:
 *
 * > **What is sent is `{gatewayId, amount}` and nothing else, and only for an
 * > amount the gateway would take.**
 *
 * `POST /tenant-wallet/topup` is `.strict()`: the source is always `platform`
 * and a billing top-up takes no coupon, so a body shaped like the user
 * deposit's (`source`, `couponCodes`) is a 400. The range check is a courtesy
 * — the service still decides — but a button that fires on `10.` or on a figure
 * below the minimum spends a start from the deposit bucket for a certain 400.
 */

const GATEWAY: DepositGateway = {
  currencyCode: "USD",
  id: "11111111-1111-4111-8111-111111111111",
  source: "platform",
  displayName: "Zarinpal",
  providerName: "zarinpal",
  category: "iranian_gateway",
  minAmount: "1.00",
  maxAmount: "500.00",
  testing: false,
  presets: [],
};

describe("topupBody", () => {
  it("is exactly the gateway id and the amount — no source, no coupons", () => {
    const body = topupBody(GATEWAY, "25");
    expect(body).toEqual({ gatewayId: GATEWAY.id, amount: "25.00" });
    expect(Object.keys(body ?? {}).sort()).toEqual(["amount", "gatewayId"]);
  });

  it("sends the amount in the route's own two-place form", () => {
    expect(topupBody(GATEWAY, "10.5")?.amount).toBe("10.50");
  });

  it("is null with no gateway picked", () => {
    expect(topupBody(null, "25")).toBeNull();
  });

  it.each(["", "10.", "0", "0.00", "abc"])("is null for %j, which is not a payable amount", (amount) => {
    expect(topupBody(GATEWAY, amount)).toBeNull();
  });

  it("is null outside the gateway's range, inclusive at both ends", () => {
    expect(topupBody(GATEWAY, "0.99")).toBeNull();
    expect(topupBody(GATEWAY, "500.01")).toBeNull();
    expect(topupBody(GATEWAY, "1")).not.toBeNull();
    expect(topupBody(GATEWAY, "500")).not.toBeNull();
  });

  it("checks only the side of the range the gateway set", () => {
    const open = { ...GATEWAY, minAmount: null, maxAmount: null };
    expect(topupBody(open, "0.01")).not.toBeNull();
    expect(topupBody(open, "9999999")).not.toBeNull();
  });
});
