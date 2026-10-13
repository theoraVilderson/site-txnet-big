import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { GrantRow } from "@/lib/billing-api";
import { resellerUserGrantsPath } from "@/lib/billing-api";
import {
  GRANT_ACTIONS,
  GRANT_ACTION_ROUTES,
  CONFIG_ACTION_KEY,
  GRANT_ACTION_KEY,
  GRANT_REFUSAL_KEYS,
  REASON_REQUIRED,
  grantKeyHeld,
  emptyDraft,
  compensationCapBody,
  grantActionBody,
  grantActionsOf,
  grantRefusalKey,
  issueBody,
  type GrantActionDraft,
} from "./_lib/grant-actions";

/**
 * An admin's actions on one of a user's Grants, from the services sheet
 * (F-311-w, `panel-web/contract.reseller-users.md`) — the panel over billing's
 * `…/users/:userId/grants/:grantId/<action>` routes (F-311-d, -h..-q). What
 * breaks here with nothing red anywhere else is the seam:
 *
 *  - **a route the controller does not serve**, spelled on this side;
 *  - **a body a schema refuses** — every one is `.strict()`, so a stray field,
 *    a zero, a missing reason or an unanswered refund is a 400 and nothing is
 *    done; the sheet must never send one;
 *  - **a refusal with no sentence** — billing answers the entitlement reasons
 *    with no i18n key, so a reason added to the controller's map would reach
 *    the admin as English, read from the controller's own map.
 */
const REPO = join(__dirname, "../../../../..");
const CONTROLLER = source("txnet-backend/billing-service/src/app/payment/gift/reseller-user-grants.controller.ts");
const SPEED = source("txnet-backend/billing-service/src/app/traffic/grant-speed.ts");

function source(rel: string) {
  return readFileSync(join(REPO, rel), "utf8");
}

const NOW = new Date("2026-09-28T10:00:00Z");
const draft = (over: Partial<GrantActionDraft>): GrantActionDraft => ({ ...emptyDraft(), requestId: "0b7c7c1e-1d4f-4a55-9d58-2f3a3c9a9f10", ...over });

const row = (over: Partial<GrantRow>): GrantRow => ({
  id: "g-1",
  label: null,
  status: "active",
  startsAt: "2026-09-01T00:00:00Z",
  endsAt: "2026-10-01T00:00:00Z",
  featureKeys: [],
  variant: null,
  billingMode: "prepaid",
  consumedBytes: "0",
  purchasedBytes: "10737418240",
  trafficUnlimited: false,
  trafficCapBytes: "10737418240",
  suspendedAt: null,
  purgeAt: null,
  lastTrafficAt: null,
  ...over,
});

describe("the routes the sheet posts to", () => {
  it("are the ones the controller serves, under the path's reseller and user", () => {
    for (const action of GRANT_ACTIONS) expect(CONTROLLER, action).toContain(`@Post('grants/:grantId/${GRANT_ACTION_ROUTES[action]}')`);
    expect(CONTROLLER).toContain("@Post('grants')");
    expect(resellerUserGrantsPath("t-1", "u-1")).toBe("/tenants/t-1/users/u-1");
  });
});

describe("a body", () => {
  it("carries a reason where the schema requires one, and is refused without it", () => {
    for (const action of REASON_REQUIRED) {
      const filled = draft({ reason: "", amount: "5", refund: false });
      expect(grantActionBody(action, filled, NOW), action).toBeNull();
    }
    expect(grantActionBody("reset", draft({ reason: "  support ticket 12 " }), NOW)).toEqual({ reason: "support ticket 12" });
    expect(grantActionBody("reset", draft({ reason: "x".repeat(501) }), NOW)).toBeNull();
  });

  it("leaves an optional reason out when none was typed", () => {
    expect(grantActionBody("unfreeze", draft({}), NOW)).toEqual({});
    expect(grantActionBody("rotate", draft({ reason: "leaked" }), NOW)).toEqual({ reason: "leaked" });
  });

  it("freezes until a future day, or with no end", () => {
    expect(grantActionBody("freeze", draft({}), NOW)).toEqual({});
    const until = grantActionBody("freeze", draft({ until: "2026-10-05" }), NOW) as { until: string };
    expect(new Date(until.until).getTime()).toBeGreaterThan(NOW.getTime());
    expect(grantActionBody("freeze", draft({ until: "2026-09-01" }), NOW)).toBeNull();
  });

  it("moves days by a whole, non-zero ±N up to 3650", () => {
    expect(grantActionBody("days", draft({ amount: "-7", reason: "r" }), NOW)).toEqual({ days: -7, reason: "r" });
    expect(grantActionBody("days", draft({ amount: "۱۰", reason: "r" }), NOW)).toEqual({ days: 10, reason: "r" });
    for (const bad of ["0", "1.5", "3651", "", "abc"]) expect(grantActionBody("days", draft({ amount: bad, reason: "r" }), NOW), bad).toBeNull();
  });

  it("moves traffic by ±GB, never 0, gifts only a positive amount", () => {
    expect(grantActionBody("traffic", draft({ amount: "-2.5", reason: "r" }), NOW)).toEqual({ gb: -2.5, reason: "r" });
    expect(grantActionBody("traffic", draft({ amount: "0", reason: "r" }), NOW)).toBeNull();
    expect(grantActionBody("traffic", draft({ amount: "100001", reason: "r" }), NOW)).toBeNull();
    expect(grantActionBody("gift", draft({ amount: "3", reason: "r" }), NOW)).toEqual({ gb: 3, reason: "r" });
    expect(grantActionBody("gift", draft({ amount: "-3", reason: "r" }), NOW)).toBeNull();
  });

  it("sets a speed or device cap, and an empty box lifts it", () => {
    expect(grantActionBody("speed", draft({ amount: "20", reason: "r" }), NOW)).toEqual({ mbps: 20, reason: "r" });
    expect(grantActionBody("speed", draft({ amount: "", reason: "r" }), NOW)).toEqual({ mbps: null, reason: "r" });
    expect(grantActionBody("speed", draft({ amount: "0", reason: "r" }), NOW)).toBeNull();
    expect(grantActionBody("devices", draft({ amount: "3", reason: "r" }), NOW)).toEqual({ limit: 3, reason: "r" });
    expect(grantActionBody("devices", draft({ amount: "", reason: "r" }), NOW)).toEqual({ limit: null, reason: "r" });
    expect(grantActionBody("devices", draft({ amount: "1001", reason: "r" }), NOW)).toBeNull();
  });

  it("deletes only once the refund is answered, either way", () => {
    expect(grantActionBody("delete", draft({ reason: "r", refund: null }), NOW)).toBeNull();
    expect(grantActionBody("delete", draft({ reason: "r", refund: false }), NOW)).toEqual({ refund: false, reason: "r" });
    expect(grantActionBody("delete", draft({ reason: "r", refund: true }), NOW)).toEqual({ refund: true, reason: "r" });
  });

  it("renews one period with no amount, or the amount typed, under one request id", () => {
    const id = draft({}).requestId;
    expect(grantActionBody("renew", draft({}), NOW)).toEqual({ requestId: id });
    expect(grantActionBody("renew", draft({ amount: "5" }), NOW)).toEqual({ requestId: id, gb: 5 });
    expect(grantActionBody("renew", draft({ days: "30", reason: "gift" }), NOW)).toEqual({ requestId: id, days: 30, reason: "gift" });
    expect(grantActionBody("renew", draft({ amount: "0", days: "0" }), NOW)).toBeNull();
  });

  it("compensates days or GB, one of the two, always with a reason (KS-1-c)", () => {
    expect(grantActionBody("compensate", draft({ days: "3", reason: "outage" }), NOW)).toEqual({ days: 3, reason: "outage" });
    expect(grantActionBody("compensate", draft({ amount: "1.5", reason: "outage" }), NOW)).toEqual({ gb: 1.5, reason: "outage" });
    expect(grantActionBody("compensate", draft({ days: "3", amount: "1", reason: "outage" }), NOW)).toBeNull();
    expect(grantActionBody("compensate", draft({ reason: "outage" }), NOW)).toBeNull();
    expect(grantActionBody("compensate", draft({ days: "-3", reason: "outage" }), NOW)).toBeNull();
    expect(grantActionBody("compensate", draft({ days: "3" }), NOW)).toBeNull();
  });

  it("reads a compensation cap as billing takes it, or null for none", () => {
    expect(compensationCapBody("7", "20")).toEqual({ days: 7, gb: 20 });
    expect(compensationCapBody("0", "0")).toEqual({ days: 0, gb: 0 });
    expect(compensationCapBody("", "20")).toBeNull();
    expect(compensationCapBody("-1", "20")).toBeNull();
    expect(compensationCapBody("1.5", "20")).toBeNull();
  });

  it("issues a variant under one request id", () => {
    expect(issueBody("v-1", "req-1", "")).toEqual({ variantId: "v-1", requestId: "req-1" });
    expect(issueBody("v-1", "req-1", " welcome ")).toEqual({ variantId: "v-1", requestId: "req-1", reason: "welcome" });
    expect(issueBody("", "req-1", "")).toBeNull();
  });
});

describe("what a Grant offers", () => {
  it("freezes an active one and unfreezes a suspended one", () => {
    expect(grantActionsOf(row({}))).toContain("freeze");
    expect(grantActionsOf(row({}))).not.toContain("unfreeze");
    expect(grantActionsOf(row({ status: "suspended" }))).toContain("unfreeze");
  });

  it("moves traffic only on a limited prepaid bag, gifts only to a metered one", () => {
    expect(grantActionsOf(row({}))).toEqual(expect.arrayContaining(["traffic", "reset"]));
    expect(grantActionsOf(row({}))).not.toContain("gift");
    expect(grantActionsOf(row({ trafficUnlimited: true }))).not.toContain("traffic");
    const metered = grantActionsOf(row({ billingMode: "metered" }));
    expect(metered).toContain("gift");
    expect(metered).not.toContain("reset");
  });

  it("compensates a live Grant with an end or a bag, and no closed one", () => {
    expect(grantActionsOf(row({}))).toContain("compensate");
    expect(grantActionsOf(row({ billingMode: "metered", endsAt: null }))).toContain("compensate");
    expect(grantActionsOf(row({ endsAt: null, trafficUnlimited: true }))).not.toContain("compensate");
    expect(grantActionsOf(row({ status: "cancelled" }))).not.toContain("compensate");
  });

  it("re-dates none that is permanent, and acts on no closed Grant but its link", () => {
    expect(grantActionsOf(row({ endsAt: null }))).not.toContain("days");
    expect(grantActionsOf(row({ status: "cancelled" }))).toEqual(["rotate"]);
  });
});

describe("a refusal", () => {
  it("has a sentence for every reason the controller answers a Grant action with", () => {
    const map = /const GRANT_ACTION_STATUS[^=]*=\s*\{([^}]*)\}/.exec(CONTROLLER)?.[1] ?? "";
    const reasons = [...map.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(10);
    for (const reason of reasons) expect(GRANT_REFUSAL_KEYS, reason).toHaveProperty(reason);
  });

  it("has one for the speed cap's own two", () => {
    const union = /type SpeedCapRejection = ([^;]*);/.exec(SPEED)?.[1] ?? "";
    for (const m of union.matchAll(/'(\w+)'/g)) expect(GRANT_REFUSAL_KEYS, m[1]).toHaveProperty(m[1]);
  });

  it("is read from the error's reason, else left to the door's or the generic sentence", () => {
    expect(grantRefusalKey({ reason: "grant_not_active" })).toBe(GRANT_REFUSAL_KEYS.grant_not_active);
    expect(grantRefusalKey({ reason: "user_not_found" })).toBeNull();
    expect(grantRefusalKey(null)).toBeNull();
  });
});

/**
 * KS-1-a (ADR-0140) — the key each act asks billing's door for, mirrored so a
 * reseller's own member is offered only what their keys open. What breaks with
 * nothing red: a support agent shown "delete" and refused, or the owner (a
 * platform user, from outside the tenant) shown nothing at all.
 */
describe("the key each act asks", () => {
  const BILLING = join(__dirname, "../../../../../txnet-backend/billing-service/src/app/payment/gift/reseller-user-grants.service.ts");

  it("mirrors billing: the link and config fixes are repair, retiring and every Grant act move value", () => {
    expect(readFileSync(BILLING, "utf8")).toContain("command.action === 'retire' ? 'grant.assign' : 'grant.repair'");
    expect(Object.entries(CONFIG_ACTION_KEY)).toEqual([
      ["regenerate", "grant.repair"],
      ["disable", "grant.repair"],
      ["enable", "grant.repair"],
      ["retire", "grant.assign"],
      ["move", "grant.repair"],
    ]);
    expect(readFileSync(BILLING, "utf8")).toMatch(/'staffWrite',\s*'grant.compensate',/);
    const keyOf = (a: string) => (a === "rotate" ? "grant.repair" : a === "compensate" ? "grant.compensate" : "grant.assign");
    for (const action of GRANT_ACTIONS) expect(GRANT_ACTION_KEY[action], action).toBe(keyOf(action));
  });

  const T = "t-reseller";
  const member = (permissions: string[]) => ({ tenant: { id: T }, permissions });

  it("a member of the path's tenant needs the key", () => {
    expect(grantKeyHeld(member(["grant.read", "grant.repair"]), T, "grant.repair")).toBe(true);
    expect(grantKeyHeld(member(["grant.read", "grant.repair"]), T, "grant.assign")).toBe(false);
    expect(grantKeyHeld(member(["*"]), T, "grant.assign")).toBe(true);
  });

  it("the owner and platform staff come from outside the tenant: the door decides, nothing is hidden", () => {
    expect(grantKeyHeld({ tenant: { id: "t-platform" }, permissions: [] }, T, "grant.assign")).toBe(true);
    expect(grantKeyHeld(null, T, "grant.read")).toBe(false);
  });
});
