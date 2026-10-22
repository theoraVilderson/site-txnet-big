/**
 * «جابه‌جایی گروهی» — a reseller's admin moves many configs to another panel
 * as a job (F-311-ae -> billing F-311-ad, D-63): every live config on one
 * panel, or of the users ticked on the users page. What would break silently:
 *
 *  - **a body billing refuses whole** — no reason, a 501st user, a user twice,
 *    both sources at once, or the source panel as target;
 *  - **the source panel offered as its own target** — billing's `same_panel`;
 *  - **a refused config with no sentence** — every reason a move's outcome
 *    carries (`CONFIG_ACTION_REJECTIONS`, `already_on_target`, `failed`)
 *    reads as itself, never blank;
 *  - **a retry that is not the same move** — "retry the failed" asks again
 *    for the job's own source and target, under a new `requestId`; the
 *    configs already moved are no longer on the source, so only the rest go;
 *  - **the wrong routes** — the pickers are the move door's, never the bulk
 *    job's `grant.assign` one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configMoveJobsApi, type ConfigMoveJob } from "@/lib/billing/config-move-jobs";
import {
  BULK_MOVE_MAX_USERS,
  bulkMoveOutcomeKey,
  bulkMoveRefusal,
  bulkMoveTargets,
  retrySelection,
  toggleTickedUser,
  validateBulkMove,
} from "./_lib/bulk-move";

const REPO = join(__dirname, "../../../../..");
const [DE, NL, FI] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const targets = [
  { id: DE, name: "de-1", region: "de", own: true },
  { id: NL, name: "nl-1", region: "nl", own: false },
  { id: FI, name: "fi-1", region: "fi", own: false },
];
const job = (over: Partial<ConfigMoveJob> = {}): ConfigMoveJob => ({
  id: "job-1",
  requestId: "req-1",
  source: { panelId: DE },
  toPanelId: NL,
  reason: "de-1 is down",
  status: "done",
  total: 10,
  processed: 10,
  ok: 7,
  refused: 2,
  failed: 1,
  createdAt: "2026-10-22T10:00:00Z",
  finishedAt: "2026-10-22T10:01:00Z",
  purgedAt: null,
  ...over,
});

describe("validateBulkMove — billing's configMoveJobSchema", () => {
  it("sends the ticked users once each, the target, a trimmed reason and the sheet's requestId", () => {
    expect(validateBulkMove({ toPanelId: NL, reason: "  de-1 is down " }, { userIds: ["u1", "u2", "u1"] }, "req-1")).toEqual({
      ok: true,
      body: { requestId: "req-1", source: { userIds: ["u1", "u2"] }, toPanelId: NL, reason: "de-1 is down" },
    });
  });

  it("sends a whole panel by its id", () => {
    expect(validateBulkMove({ toPanelId: NL, reason: "x" }, { panelId: DE }, "r")).toMatchObject({ ok: true, body: { source: { panelId: DE } } });
  });

  it("refuses no target, the source panel as target, no reason and one over 500", () => {
    expect(validateBulkMove({ toPanelId: "", reason: "x" }, { panelId: DE }, "r")).toMatchObject({ ok: false, errors: { toPanelId: expect.any(String) } });
    expect(validateBulkMove({ toPanelId: DE, reason: "x" }, { panelId: DE }, "r")).toMatchObject({ ok: false, errors: { toPanelId: expect.any(String) } });
    expect(validateBulkMove({ toPanelId: NL, reason: "  " }, { panelId: DE }, "r")).toMatchObject({ ok: false, errors: { reason: expect.any(String) } });
    expect(validateBulkMove({ toPanelId: NL, reason: "x".repeat(501) }, { panelId: DE }, "r")).toMatchObject({ ok: false, errors: { reason: expect.any(String) } });
  });

  it("refuses no user, no panel, and a pick past billing's 500 users", () => {
    expect(validateBulkMove({ toPanelId: NL, reason: "x" }, { userIds: [] }, "r")).toMatchObject({ ok: false, errors: { source: expect.any(String) } });
    expect(validateBulkMove({ toPanelId: NL, reason: "x" }, { panelId: "" }, "r")).toMatchObject({ ok: false, errors: { source: expect.any(String) } });
    const many = Array.from({ length: BULK_MOVE_MAX_USERS + 1 }, (_, i) => `u${i}`);
    expect(validateBulkMove({ toPanelId: NL, reason: "x" }, { userIds: many }, "r")).toMatchObject({ ok: false, errors: { source: expect.any(String) } });
    const schema = readFileSync(join(REPO, "txnet-backend/billing-service/src/app/payment/gift/config-move-job.schema.ts"), "utf8");
    expect(schema).toContain(`CONFIG_MOVE_MAX_USERS = ${BULK_MOVE_MAX_USERS};`);
  });
});

describe("the ticks and the targets", () => {
  it("ticks a user once, unticks on a second press, and stops at billing's 500", () => {
    expect(toggleTickedUser(["u1"], "u2")).toEqual(["u1", "u2"]);
    expect(toggleTickedUser(["u1", "u2"], "u1")).toEqual(["u2"]);
    const full = Array.from({ length: BULK_MOVE_MAX_USERS }, (_, i) => `u${i}`);
    expect(toggleTickedUser(full, "one-more")).toBe(full);
  });

  it("never offers the panel being emptied; ticked users may go to any target", () => {
    expect(bulkMoveTargets(targets, { panelId: DE }).map((p) => p.id)).toEqual([NL, FI]);
    expect(bulkMoveTargets(targets, { userIds: ["u1"] })).toHaveLength(3);
  });
});

describe("a refused config reads as its reason", () => {
  it("has a sentence for every reason billing writes on a move's outcome", () => {
    const actions = readFileSync(join(REPO, "txnet-backend/billing-service/src/app/traffic/config-actions.ts"), "utf8");
    const list = actions.match(/CONFIG_ACTION_REJECTIONS = \[([^\]]+)\]/)?.[1] ?? "";
    const reasons = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(5);
    const drain = readFileSync(join(REPO, "txnet-backend/billing-service/src/app/payment/gift/config-move-drain.ts"), "utf8");
    expect(drain).toContain("new MoveItemRefused('already_on_target')");
    for (const reason of [...reasons, "already_on_target", "failed"]) expect(bulkMoveOutcomeKey(reason), reason).toBeTruthy();
    expect(bulkMoveOutcomeKey("already_on_target")).not.toBe(bulkMoveOutcomeKey("failed"));
    expect(bulkMoveOutcomeKey("something_new")).toBe(bulkMoveOutcomeKey("failed"));
  });

  it("names every refusal of the job routes, and leaves any other error to the page", () => {
    const job = readFileSync(join(REPO, "txnet-backend/billing-service/src/app/payment/gift/config-move-job.ts"), "utf8");
    const union = job.match(/type ConfigMoveJobRejection = ([^;]+);/)?.[1] ?? "";
    const reasons = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(reasons).toContain("selection_empty");
    for (const reason of reasons) expect(bulkMoveRefusal(reason), reason).toBeTruthy();
    expect(bulkMoveRefusal("reseller_suspended")).toBeNull();
    expect(bulkMoveRefusal(undefined)).toBeNull();
  });
});

describe("retry the failed", () => {
  it("is the job's own source and target, once it ended with configs left behind", () => {
    expect(retrySelection(job())).toEqual({ source: { panelId: DE }, toPanelId: NL });
    expect(retrySelection(job({ source: { userIds: ["u1"] } }))).toEqual({ source: { userIds: ["u1"] }, toPanelId: NL });
  });

  it("offers nothing while it runs, or when every config moved", () => {
    expect(retrySelection(job({ status: "running" }))).toBeNull();
    expect(retrySelection(job({ refused: 0, failed: 0, ok: 10 }))).toBeNull();
  });

  it("offers the rest of a stopped job too: what it never reached is still on the source", () => {
    expect(retrySelection(job({ status: "cancelled", processed: 4, ok: 4, refused: 0, failed: 0 }))).toEqual({ source: { panelId: DE }, toPanelId: NL });
  });
});

describe("the door", () => {
  const fetched: { url: string; method: string; body: unknown }[] = [];
  afterEach(() => {
    fetched.length = 0;
    vi.unstubAllGlobals();
  });
  const stub = (answer: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        fetched.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify({ success: true, data: answer }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

  it("reads its pickers, counts, starts, watches and stops under the tenant's move-jobs path", async () => {
    const api = configMoveJobsApi("t-1");
    stub({ sources: [], targets });
    expect((await api.panels()).targets).toEqual(targets);
    stub({ count: 12 });
    expect(await api.count({ source: { panelId: DE }, toPanelId: NL })).toBe(12);
    stub(job());
    await api.start({ requestId: "r", source: { panelId: DE }, toPanelId: NL, reason: "x" });
    await api.job("job-1");
    await api.cancel("job-1");
    stub({ rows: [], page: 2, pageSize: 20, purgedAt: null });
    await api.outcomes("job-1", 2, 20);
    stub({ rows: [], page: 1, pageSize: 5, total: 0 });
    await api.jobs(1, 5);
    expect(fetched.map((f) => `${f.method} ${f.url.replace(/^.*\/billing/, "")}`)).toEqual([
      "GET /tenants/t-1/configs/move-jobs/panels",
      "POST /tenants/t-1/configs/move-jobs/count",
      "POST /tenants/t-1/configs/move-jobs",
      "GET /tenants/t-1/configs/move-jobs/job-1",
      "POST /tenants/t-1/configs/move-jobs/job-1/cancel",
      "GET /tenants/t-1/configs/move-jobs/job-1/outcomes?page=2&pageSize=20&problems=true",
      "GET /tenants/t-1/configs/move-jobs?page=1&pageSize=5",
    ]);
  });
});
