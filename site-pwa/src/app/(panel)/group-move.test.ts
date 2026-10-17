/**
 * "Move to another group" — Grants moved to another panel group as a job
 * (F-027-ev -> billing F-027-et, ADR-0127 decision 5). What would break
 * silently:
 *
 *  - **a body billing refuses whole** — no reason, a 501st Grant, a Grant
 *    twice, or both sources at once; the form must not send it;
 *  - **a group offered as its own target** — billing's `same_group` for every
 *    Grant of it; a move from a group never lists that group;
 *  - **a refused Grant with no sentence** — every reason billing writes on an
 *    outcome (`GRANT_REGROUP_REJECTIONS`, the reseller's limit, `failed`)
 *    reads as itself, never blank;
 *  - **the wrong door** — the owner's `/systems` routes and a reseller's
 *    `/tenants/:id` routes are different scopes;
 *  - **the job heard on a channel the reader cannot hold** — a reseller's
 *    admin on the platform's panel is on the platform tenant, so the progress
 *    reaches them on their own `user:` channel.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RealtimeEvents } from "@/generated/wire";
import { resellerGroupMovesApi, systemsGroupMovesApi } from "@/lib/billing/grant-group-moves";
import { GROUP_MOVE_EVENTS, GROUP_MOVE_MAX_GRANTS, groupMoveChannel, groupMoveRefusalKey, groupMoveTargets, validateGroupMove } from "./_lib/group-move";

const REPO = join(__dirname, "../../../..");
const [EU, ASIA, GAMING] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const groups = [
  { id: EU, name: "EU" },
  { id: ASIA, name: "Asia" },
  { id: GAMING, name: "Gaming" },
];

describe("validateGroupMove — billing's grantGroupMoveJobSchema", () => {
  it("sends the ticked Grants once each, the target, a trimmed reason and the form's requestId", () => {
    expect(validateGroupMove({ toGroupId: ASIA, reason: "  EU is full  " }, { grantIds: ["g1", "g2", "g1"] }, "req-1")).toEqual({
      ok: true,
      body: { requestId: "req-1", source: { grantIds: ["g1", "g2"] }, toGroupId: ASIA, reason: "EU is full" },
    });
  });

  it("sends a whole group by its id", () => {
    expect(validateGroupMove({ toGroupId: ASIA, reason: "x" }, { fromGroupId: EU }, "r")).toMatchObject({ ok: true, body: { source: { fromGroupId: EU } } });
  });

  it("refuses no target, no reason, a reason over 500, and the source group as target", () => {
    expect(validateGroupMove({ toGroupId: "", reason: "x" }, { grantIds: ["g1"] }, "r")).toMatchObject({ ok: false, errors: { toGroupId: expect.any(String) } });
    expect(validateGroupMove({ toGroupId: ASIA, reason: " " }, { grantIds: ["g1"] }, "r")).toMatchObject({ ok: false, errors: { reason: expect.any(String) } });
    expect(validateGroupMove({ toGroupId: ASIA, reason: "x".repeat(501) }, { grantIds: ["g1"] }, "r")).toMatchObject({ ok: false, errors: { reason: expect.any(String) } });
    expect(validateGroupMove({ toGroupId: EU, reason: "x" }, { fromGroupId: EU }, "r")).toMatchObject({ ok: false, errors: { toGroupId: expect.any(String) } });
  });

  it("refuses an empty pick and one past billing's 500", () => {
    expect(validateGroupMove({ toGroupId: ASIA, reason: "x" }, { grantIds: [] }, "r")).toMatchObject({ ok: false, errors: { source: expect.any(String) } });
    const many = Array.from({ length: GROUP_MOVE_MAX_GRANTS + 1 }, (_, i) => `g${i}`);
    expect(validateGroupMove({ toGroupId: ASIA, reason: "x" }, { grantIds: many }, "r")).toMatchObject({ ok: false, errors: { source: expect.any(String) } });
    const schema = readFileSync(join(REPO, "txnet-backend/billing-service/src/app/payment/gift/grant-group-move.schema.ts"), "utf8");
    expect(schema).toContain(`GRANT_GROUP_MOVE_MAX_GRANTS = ${GROUP_MOVE_MAX_GRANTS};`);
  });
});

describe("groupMoveTargets", () => {
  it("never offers the group being emptied; ticked Grants may go to any group offered", () => {
    expect(groupMoveTargets(groups, { fromGroupId: EU }).map((g) => g.id)).toEqual([ASIA, GAMING]);
    expect(groupMoveTargets(groups, { grantIds: ["g1"] })).toHaveLength(3);
  });
});

describe("a refused Grant reads as its reason", () => {
  it("has a sentence of its own for every reason billing writes on an outcome", () => {
    const regroup = readFileSync(join(REPO, "txnet-backend/billing-service/src/app/traffic/grant-regroup.ts"), "utf8");
    const list = regroup.match(/GRANT_REGROUP_REJECTIONS = \[([^\]]+)\]/)?.[1] ?? "";
    const reasons = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(5);
    const failed = groupMoveRefusalKey("failed");
    for (const reason of [...reasons, "reseller_limit_reached"]) {
      expect(groupMoveRefusalKey(reason), reason).toBeTruthy();
      expect(groupMoveRefusalKey(reason), reason).not.toBe(failed);
    }
    expect(groupMoveRefusalKey("something_new")).toBe(failed);
  });
});

describe("the two doors", () => {
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

  it("the owner counts and starts on /systems, and takes every group as a target", async () => {
    stub([{ id: EU, name: "EU", members: [] }]);
    const api = systemsGroupMovesApi();
    expect(await api.targets()).toEqual([{ id: EU, name: "EU" }]);
    stub({ grants: 3, keep: 2, move: 4 });
    expect(await api.count({ source: { fromGroupId: EU }, toGroupId: ASIA })).toEqual({ grants: 3, keep: 2, move: 4 });
    await api.cancel("job-1");
    expect(fetched.map((f) => `${f.method} ${f.url.replace(/^.*\/billing/, "")}`)).toEqual([
      "GET /systems/panel-groups",
      "POST /systems/grant-group-moves/count",
      "POST /systems/grant-group-moves/job-1/cancel",
    ]);
  });

  it("a reseller's admin moves under its tenant's path, into the groups its tenant sells", async () => {
    stub({ groups: [{ id: ASIA, name: "Asia" }] });
    const api = resellerGroupMovesApi("t-1");
    expect(await api.targets()).toEqual([{ id: ASIA, name: "Asia" }]);
    await api.outcomes("job-1", 2, 20);
    expect(fetched.map((f) => `${f.method} ${f.url.replace(/^.*\/billing/, "")}`)).toEqual([
      "GET /tenants/t-1/grant-group-moves/groups",
      "GET /tenants/t-1/grant-group-moves/job-1/outcomes?page=2&pageSize=20&problems=true",
    ]);
  });
});

describe("the job, live", () => {
  it("is heard by its progress event on the reader's own user: channel, which billing names in the payload", () => {
    expect(GROUP_MOVE_EVENTS).toEqual([RealtimeEvents.configMoveJobProgress]);
    expect(groupMoveChannel("u-1")).toBe("user:u-1");
    expect(groupMoveChannel(null)).toBeNull();
    const job = readFileSync(join(REPO, "txnet-backend/billing-service/src/app/payment/gift/config-move-job.ts"), "utf8");
    expect(job).toMatch(/CONFIG_MOVE_JOB_PROGRESS, payload: \{[^}]*userId: job\.actorUserId/);
    const push = readFileSync(join(REPO, "txnet-backend/worker-service/src/app/outbox/live-push.consumer.ts"), "utf8");
    expect(push).toMatch(/CONFIG_MOVE_JOB_PROGRESS\]: \{ audience: \['user', 'tenant'\]/);
  });
});
