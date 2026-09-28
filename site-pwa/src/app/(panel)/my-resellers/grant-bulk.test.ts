import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resellerGrantsPath } from "@/lib/billing-api";
import { emptyDraft, type GrantActionDraft } from "./_lib/grant-actions";
import {
  BULK_ACTIONS,
  BULK_ACTION_NAMES,
  BULK_MAX_GRANTS,
  HISTORY_ACTION_KEYS,
  bulkBody,
  bulkRefusalKey,
  historyActionKey,
  toggleTicked,
} from "./_lib/grant-bulk";

/**
 * The admin's users page acting on many Grants at once, and a Grant's history
 * (F-311-x, `panel-web/contract.reseller-users.md`) — the panel over billing's
 * `tenants/:id/grants/{by-lines,bulk}` (F-311-t, -u, -u1) and `…/history`
 * (F-311-r). What breaks here with nothing red anywhere else is the seam:
 *
 *  - **an action name the bulk schema does not take** — its union is
 *    `.strict()` per action, so a stray field or a missing reason refuses
 *    every Grant in the request;
 *  - **a double click that acts twice** — one `requestId` per confirm;
 *  - **a refusal or a history row with no sentence**, read from the backend's
 *    own lists so one added there fails here.
 */
const REPO = join(__dirname, "../../../../..");
const GIFT = "txnet-backend/billing-service/src/app/payment/gift";
const source = (rel: string) => readFileSync(join(REPO, rel), "utf8");

const REQUEST = "0b7c7c1e-1d4f-4a55-9d58-2f3a3c9a9f10";
const draft = (over: Partial<GrantActionDraft>): GrantActionDraft => ({ ...emptyDraft(), requestId: REQUEST, ...over });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

describe("the bulk routes", () => {
  it("are the ones billing serves, under the path's reseller", () => {
    expect(resellerGrantsPath("t 1")).toBe("/tenants/t%201/grants");
    expect(source(`${GIFT}/reseller-grants-by-lines.controller.ts`)).toMatch(/@Controller\('billing\/tenants\/:tenantId\/grants'\)[\s\S]*@Post\('by-lines'\)/);
    expect(source(`${GIFT}/reseller-grants-bulk.controller.ts`)).toMatch(/@Controller\('billing\/tenants\/:tenantId\/grants'\)[\s\S]*@Post\('bulk'\)/);
    expect(source(`${GIFT}/reseller-user-grants.controller.ts`)).toMatch(/@Get\('grants\/:grantId\/history'\)/);
  });

  it("offers exactly the actions the bulk schema takes, each by its bulk name", () => {
    const schema = source(`${GIFT}/grant-bulk.schema.ts`);
    const literals = [...schema.matchAll(/action: z\.literal\('([a-z_]+)'\)/g)].map((m) => m[1]).sort();
    expect(BULK_ACTIONS.map((a) => BULK_ACTION_NAMES[a]).sort()).toEqual(literals);
  });
});

describe("a bulk body", () => {
  it("carries the confirm's request id, the bulk name, the ids and the reason", () => {
    expect(bulkBody("days", ids(2), draft({ amount: "3", reason: " outage " }))).toEqual({
      requestId: REQUEST,
      action: "days",
      grantIds: ids(2),
      days: 3,
      reason: "outage",
    });
    expect(bulkBody("reset", ids(1), draft({ reason: "r" }))).toEqual({ requestId: REQUEST, action: "traffic_reset", grantIds: ids(1), reason: "r" });
    expect(bulkBody("gift", ids(1), draft({ amount: "5", reason: "r" }))).toMatchObject({ action: "traffic_gift", gb: 5 });
  });

  it("asks a reason for every action, freeze and unfreeze included", () => {
    for (const action of BULK_ACTIONS) {
      expect(bulkBody(action, ids(1), draft({ amount: "3", reason: "" })), action).toBeNull();
    }
    expect(bulkBody("unfreeze", ids(1), draft({ reason: "back" }))).toEqual({ requestId: REQUEST, action: "unfreeze", grantIds: ids(1), reason: "back" });
  });

  it("takes 1..50 Grants, each once", () => {
    expect(bulkBody("unfreeze", [], draft({ reason: "r" }))).toBeNull();
    expect(bulkBody("unfreeze", ids(BULK_MAX_GRANTS + 1), draft({ reason: "r" }))).toBeNull();
    expect(bulkBody("unfreeze", ids(BULK_MAX_GRANTS), draft({ reason: "r" }))?.grantIds).toHaveLength(BULK_MAX_GRANTS);
    expect(bulkBody("unfreeze", [...ids(2), ...ids(2)], draft({ reason: "r" }))?.grantIds).toEqual(ids(2));
  });

  it("holds the single act's bounds: no zero, an empty cap lifts it", () => {
    expect(bulkBody("days", ids(1), draft({ amount: "0", reason: "r" }))).toBeNull();
    expect(bulkBody("traffic", ids(1), draft({ amount: "0", reason: "r" }))).toBeNull();
    expect(bulkBody("speed", ids(1), draft({ amount: "", reason: "r" }))).toMatchObject({ action: "speed", mbps: null });
  });

  it("ticks at most 50, and a second tick unticks", () => {
    expect(toggleTicked(["a"], "a")).toEqual([]);
    expect(toggleTicked(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleTicked(ids(BULK_MAX_GRANTS), "x")).toHaveLength(BULK_MAX_GRANTS);
  });
});

describe("a bulk outcome's refusal", () => {
  it("has a sentence for every reason a single act answers, and for the bulk's own two", () => {
    const map = /const GRANT_ACTION_STATUS[^=]*=\s*\{([^}]*)\}/.exec(source(`${GIFT}/reseller-user-grants.controller.ts`))?.[1] ?? "";
    const reasons = [...map.matchAll(/([a-z_]+):/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(10);
    for (const reason of [...reasons, "rate_limit_unsupported", "grant_not_found"]) {
      expect(bulkRefusalKey(reason), reason).not.toBe(bulkRefusalKey("__unknown__"));
    }
  });

  it("is the generic failure for a reason nobody wrote a sentence for", () => {
    expect(bulkRefusalKey("__unknown__")).toBe(bulkRefusalKey("failed"));
  });
});

describe("a history row", () => {
  it("names every act a Grant's history can hold", () => {
    const audit = source("txnet-backend/billing-service/src/app/grant-audit/grant-audit.ts");
    const union = (name: string) => [
      ...(new RegExp(`export type ${name} = Extract<[^;]*;`).exec(audit)?.[0] ?? "").matchAll(/'([a-z_]+)'/g),
    ].map((m) => m[1]);
    const acts = [...union("GrantAuditAction"), ...union("ConfigAuditAction")];
    expect(acts.length).toBeGreaterThan(15);
    expect(Object.keys(HISTORY_ACTION_KEYS).sort()).toEqual(acts.sort());
  });

  it("falls back to a plain label for an act added later", () => {
    expect(historyActionKey("grant_freeze")).toBe(HISTORY_ACTION_KEYS.grant_freeze);
    expect(historyActionKey("wallet_manual_adjust")).not.toBe(HISTORY_ACTION_KEYS.grant_freeze);
    expect(typeof historyActionKey("wallet_manual_adjust")).toBe("string");
  });
});
