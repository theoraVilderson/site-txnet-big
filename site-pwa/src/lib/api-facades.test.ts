import { describe, expect, it } from "vitest";
import { accountCalls } from "./auth/account";
import { sessionCalls } from "./auth/credential";
import { signInCalls } from "./auth/sign-in";
import { authApi } from "./auth-api";
import { configMoveCalls } from "./billing/config-moves";
import { couponCalls } from "./billing/coupons";
import { depositCalls } from "./billing/deposit";
import { gatewayCalls } from "./billing/gateways";
import { grantCalls } from "./billing/grants";
import { manualPaymentCalls } from "./billing/manual-payments";
import { transferCalls } from "./billing/manual-transfer";
import { panelGroupCalls } from "./billing/panel-groups";
import { renewalCalls } from "./billing/renewal";
import { shopCalls } from "./billing/shop";
import { systemsCalls } from "./billing/systems";
import { walletCalls } from "./billing/wallet";
import { billingApi } from "./billing-api";

// `billingApi` and `authApi` are spreads of per-domain parts (FE-1-h). A spread
// keeps the last of two equal keys without a word, so a method added to one part
// under a name another part already uses would replace it for every caller.
function collisions(parts: Record<string, object>): string[] {
  const owner = new Map<string, string>();
  const out: string[] = [];
  for (const [part, calls] of Object.entries(parts)) {
    for (const key of Object.keys(calls)) {
      const first = owner.get(key);
      if (first) out.push(`${key}: ${first} and ${part}`);
      else owner.set(key, part);
    }
  }
  return out;
}

const billingParts = {
  walletCalls, depositCalls, shopCalls, grantCalls, manualPaymentCalls, transferCalls,
  systemsCalls, panelGroupCalls, gatewayCalls, couponCalls, configMoveCalls, renewalCalls,
};
const authParts = { signInCalls, sessionCalls, accountCalls };

describe("the split API facades (FE-1-h)", () => {
  it("no two billing parts name the same call", () => {
    expect(collisions(billingParts)).toEqual([]);
  });

  it("no two auth parts name the same call", () => {
    expect(collisions(authParts)).toEqual([]);
  });

  it("each facade is exactly its parts", () => {
    const keys = (parts: Record<string, object>) => Object.values(parts).flatMap((p) => Object.keys(p)).sort();
    expect(Object.keys(billingApi).sort()).toEqual(keys(billingParts));
    expect(Object.keys(authApi).sort()).toEqual(keys(authParts));
  });
});
