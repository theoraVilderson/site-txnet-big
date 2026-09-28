import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { myResellerUserPath, myResellerUsersPath } from "@/lib/routes";
import { resellerUsersApiPath } from "@/lib/auth-api";
import { resellerUserGrantsPath } from "@/lib/billing-api";
import {
  ADMIN_ACTIONS,
  ADMIN_REFUSAL_KEYS,
  MOVE_REFUSALS,
  USERS_QUERY_MIN,
  USER_REFUSAL_KEYS,
  adminActionBody,
  userRefusalKey,
  usersQuery,
} from "./_lib/users";

/**
 * A reseller's users, and one user's services, `/my-resellers/[id]/users[/…]`
 * (F-311-v) — the panel over auth's user list (F-311-a) and billing's reads
 * and config actions on one user (F-311-f/g). What breaks here with nothing
 * red anywhere else is the seam between the screen and those routes:
 *
 *  - **a call that leaves out the reseller or the user.** The owner signs in
 *    to the platform owner's tenant (ADR-0059), so a path built from the
 *    session would read the platform's users, or the admin's own services;
 *  - **a body the schema refuses** — a `reason` on anything but a disable, or
 *    a disable with none: `adminConfigActionSchema` refuses both, and the
 *    whole request fails rather than one config;
 *  - **a search the route refuses.** `q` is 3-64 characters; one or two typed
 *    letters would turn the list into a 400;
 *  - **a refusal with no sentence**, read from the controllers' own maps.
 */
const REPO = join(__dirname, "../../../../..");
const GRANTS_CONTROLLER = "txnet-backend/billing-service/src/app/payment/gift/reseller-user-grants.controller.ts";
const USER_CONFIGS = "txnet-backend/billing-service/src/app/traffic/user-configs.ts";
const USERS_CONTROLLER = "txnet-backend/auth-service/src/app/auth/users/reseller-users.controller.ts";
const CONSOLE = "site-pwa/src/app/(panel)/my-resellers/[id]/_components/OnboardingConsoleView.tsx";

const source = (rel: string) => readFileSync(join(REPO, rel), "utf8");

/** The keys of a `const STATUS: Record<…> = { … }` map in a controller. */
function statusReasons(text: string): string[] {
  const block = /const STATUS[^=]*=\s*\{([^}]*)\}/.exec(text)?.[1] ?? "";
  return [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
}

describe("the routes the screens call", () => {
  it("names the reseller and the user in the path, never the session's", () => {
    expect(resellerUsersApiPath("t-1")).toBe("/auth/tenants/t-1/users");
    expect(resellerUserGrantsPath("t-1", "u-1")).toBe("/tenants/t-1/users/u-1");
    expect(resellerUserGrantsPath("a b", "c/d")).toBe("/tenants/a%20b/users/c%2Fd");
  });

  it("is the path the controllers serve", () => {
    expect(source(GRANTS_CONTROLLER)).toContain("@Controller('billing/tenants/:tenantId/users/:userId')");
    expect(source(USERS_CONTROLLER)).toContain("tenants/:tenantId/users");
  });

  it("has a page for the list and one for each user, under the reseller", () => {
    expect(myResellerUsersPath("t-1")).toBe("/my-resellers/t-1/users");
    expect(myResellerUserPath("t-1", "u/1")).toBe("/my-resellers/t-1/users/u%2F1");
  });

  it("is linked from the reseller's console", () => {
    expect(source(CONSOLE)).toContain("myResellerUsersPath(id)");
  });
});

describe("an admin's config action", () => {
  it("offers only actions billing's admin route takes", () => {
    const served = /ADMIN_CONFIG_ACTIONS = \[([^\]]*)\]/.exec(source(USER_CONFIGS))?.[1] ?? "";
    for (const action of ADMIN_ACTIONS) expect(served).toContain(`'${action}'`);
  });

  it("carries a reason with a disable, and only with a disable", () => {
    expect(adminActionBody("disable", ["c1"], "  leaked  ")).toEqual({ action: "disable", configIds: ["c1"], reason: "leaked" });
    expect(adminActionBody("enable", ["c1"], "leaked")).toEqual({ action: "enable", configIds: ["c1"] });
    expect(adminActionBody("regenerate", ["c1", "c2"])).toEqual({ action: "regenerate", configIds: ["c1", "c2"] });
  });

  it("carries a target panel with a move, and only with a move", () => {
    expect(adminActionBody("move", ["c1"], undefined, "p-1")).toEqual({ action: "move", configIds: ["c1"], toPanelId: "p-1" });
    expect(adminActionBody("move", ["c1"])).toBeNull();
    expect(adminActionBody("retire", ["c1"], undefined, "p-1")).toEqual({ action: "retire", configIds: ["c1"] });
  });

  it("asks billing's own route for the panels a move may name", () => {
    expect(source(GRANTS_CONTROLLER)).toContain("@Get('configs/move-targets')");
  });

  it("has a sentence of its own for a move's two refusals", () => {
    for (const reason of MOVE_REFUSALS) expect(ADMIN_REFUSAL_KEYS[reason]).not.toBe(ADMIN_REFUSAL_KEYS.failed);
  });

  it("sends no disable the schema would refuse", () => {
    expect(adminActionBody("disable", ["c1"], "   ")).toBeNull();
    expect(adminActionBody("disable", ["c1"], "x".repeat(201))).toBeNull();
    expect(adminActionBody("retire", [])).toBeNull();
    expect(adminActionBody("retire", Array.from({ length: 51 }, (_, i) => `c${i}`))).toBeNull();
  });
});

describe("the user list's search", () => {
  it("sends no query shorter than the route takes", () => {
    expect(usersQuery("ab", 1)).toEqual({ page: 1 });
    expect(usersQuery("  ali  ", 2)).toEqual({ q: "ali", page: 2 });
    expect(USERS_QUERY_MIN).toBe(3);
  });

  it("cuts a query at the route's 64", () => {
    expect(usersQuery("x".repeat(80), 1).q).toHaveLength(64);
  });
});

describe("a refusal", () => {
  it("has a sentence for every reason either door answers", () => {
    const reasons = new Set([...statusReasons(source(GRANTS_CONTROLLER)), ...statusReasons(source(USERS_CONTROLLER))]);
    expect(reasons.size).toBeGreaterThan(4);
    for (const reason of reasons) expect(USER_REFUSAL_KEYS, reason).toHaveProperty(reason);
  });

  it("is read from the error's reason, else left to the generic sentence", () => {
    expect(userRefusalKey({ reason: "user_not_found" })).toBe(USER_REFUSAL_KEYS.user_not_found);
    expect(userRefusalKey({ reason: "something_else" })).toBeNull();
    expect(userRefusalKey(new Error("x"))).toBeNull();
  });
});
