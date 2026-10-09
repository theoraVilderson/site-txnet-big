import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { accessHistoryPath, accessLogPath, type AccessAct } from "@/lib/auth-api";
import { ACCESS_ACT_KEYS, actKeysMoved, actSentence } from "./_lib/access-history";

/**
 * Access history (AC-1-p) over `GET …/users/:userId/access-history` and
 * `GET …/access-history`. What breaks here with nothing red on the server:
 *
 *  - **an act with no sentence** — the server's `ACCESS_ACTIONS` grows and the
 *    panel shows a raw enum value; read out of the service's own list;
 *  - **a give and a take that read the same** — one action, `effect` decides;
 *  - **a role's or a group's edit with no keys** — the log has no history row
 *    to carry them, so they are the act's own before and after.
 */
const REPO = join(__dirname, "../../../../..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

const act = (over: Partial<AccessAct>): AccessAct => ({
  id: "a-1",
  at: "2026-10-09T10:00:00.000Z",
  action: "role_change",
  actor: { id: "u-boss", name: "Boss" },
  target: { type: "user", id: "u-ali", name: "Ali" },
  before: null,
  after: null,
  reason: null,
  ...over,
});

describe("access history", () => {
  it("has a sentence for every act the service lists", () => {
    const source = read("txnet-backend/auth-service/src/app/access-history/access-history.service.ts");
    const list = source.slice(source.indexOf("export const ACCESS_ACTIONS"), source.indexOf("] as const"));
    const actions = [...list.matchAll(/AdminAction\.(\w+)/g)].map((m) => m[1]);
    expect(actions.length).toBeGreaterThan(8);
    for (const action of actions) expect(actSentence(act({ action })).key, action).not.toBe(ACCESS_ACT_KEYS.unknown);
  });

  it("tells a key given from one taken, and names the key", () => {
    const give = actSentence(act({ action: "user_permission_set", after: { key: "audit.read", effect: "give" } }));
    const take = actSentence(act({ action: "user_permission_set", after: { key: "audit.read", effect: "take" } }));
    expect(give.key).toBe(ACCESS_ACT_KEYS.user_permission_set_give);
    expect(take.key).toBe(ACCESS_ACT_KEYS.user_permission_set_take);
    expect(give.params).toMatchObject({ target: "Ali", key: "audit.read" });
  });

  it("names a role change by both roles", () => {
    const s = actSentence(act({ before: { roleName: "User" }, after: { roleName: "Operator" } }));
    expect(s.params).toMatchObject({ target: "Ali", from: "User", to: "Operator" });
  });

  it("reads what a role's or a group's edit gave and took from its own before and after", () => {
    expect(actKeysMoved(act({ action: "role_keys_set", before: { keys: ["grant.assign", "user.read"] }, after: { keys: ["user.read", "audit.read"] } }))).toEqual({
      given: ["audit.read"],
      taken: ["grant.assign"],
    });
    expect(actKeysMoved(act({ action: "staff_seat_remove" }))).toEqual({ given: [], taken: [] });
  });

  it("asks the routes the service serves", () => {
    expect(accessHistoryPath("t-1", "u-2")).toBe("/auth/tenants/t-1/users/u-2/access-history");
    expect(accessLogPath("t-1")).toBe("/auth/tenants/t-1/access-history");
    const controller = read("txnet-backend/auth-service/src/app/access-history/access-history.controller.ts");
    expect(controller).toContain("@Get('users/:userId/access-history')");
    expect(controller).toContain("@Get('access-history')");
  });
});
