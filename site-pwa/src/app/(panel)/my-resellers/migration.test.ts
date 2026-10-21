/**
 * The import page (F-201-f, D-63; entitlement `contract.import.md`): what the
 * page shows for each state of a run, what it sends, and where it hears the
 * run move. Nothing here decides the import — billing does — so the rules
 * held are the page's own:
 *
 *  - every state lands on exactly one step, and a draft the preview sent back
 *    asks for what is missing: the mapping, or the login again;
 *  - a login for a run is for that run's panel: an address with another
 *    origin would read another panel under the same run's keys;
 *  - an inbound maps to a prepaid plan only (rule 10) — a metered one is not
 *    offered, and a switched-off product or plan neither;
 *  - the rollback is offered inside its window only, with the days left;
 *  - the page hears the run on the viewer's `user:` channel, filtered to the
 *    run, and on the reseller's `tenant:` channel only when it is the session's.
 */
import { describe, expect, it } from "vitest";
import type { MigrationRun, UsersCatalogProduct } from "@/lib/billing-api";
import { tenantChannel, userChannel } from "@/lib/realtime";
import { REALTIME_TENANT_READ } from "@/lib/tenant-channel";
import {
  IMPORT_FAMILIES,
  commitProgress,
  connectFormErrors,
  emptyConnectForm,
  mappingBody,
  mappingOptions,
  migrationLiveOf,
  rollbackDaysLeft,
  sourceLoginOf,
  stageOf,
} from "./_lib/migration";
import { DRIVER_TYPES } from "../systems/_lib/systems";

const run = (over: Partial<MigrationRun> = {}): MigrationRun => ({
  id: "run-1",
  kind: "panel",
  sourceFamily: "marzban",
  sourceAddress: "https://old.example.com:8443",
  status: "draft",
  failureReason: null,
  plannedCreate: 0,
  plannedUpdate: 0,
  plannedSkip: 0,
  committedItems: 0,
  failedItems: 0,
  rollbackUntil: null,
  snapshotsPurgedAt: null,
  createdAt: "2026-10-21T08:00:00Z",
  updatedAt: "2026-10-21T08:00:00Z",
  inbounds: [],
  ...over,
});

const inbound = { inboundRemoteId: "1", tag: "vless-ws", protocol: "vless", clientCount: 12, variantId: null };

describe("which step a run is on", () => {
  it("a new draft asks for the login; a draft sent back for its mapping asks for the mapping", () => {
    expect(stageOf(run())).toBe("login");
    expect(stageOf(run({ inbounds: [inbound], failureReason: "inbounds_unmapped" }))).toBe("mapping");
  });

  it("a draft the source refused asks for the login again, even with inbounds read before", () => {
    expect(stageOf(run({ inbounds: [inbound], failureReason: "source_login_refused" }))).toBe("login");
    expect(stageOf(run({ inbounds: [inbound], failureReason: "credential_unavailable" }))).toBe("login");
  });

  it("every other state is one step", () => {
    expect(stageOf(run({ status: "previewing" }))).toBe("reading");
    expect(stageOf(run({ status: "previewed" }))).toBe("report");
    expect(stageOf(run({ status: "committing" }))).toBe("importing");
    expect(stageOf(run({ status: "committed" }))).toBe("imported");
    expect(stageOf(run({ status: "rolling_back" }))).toBe("rollingBack");
    for (const status of ["rolled_back", "cancelled", "expired"] as const) expect(stageOf(run({ status }))).toBe("closed");
  });
});

describe("the connect form", () => {
  const filled = { ...emptyConnectForm(), family: "marzban" as const, address: " https://old.example.com:8443/dashboard ", username: "admin", password: "p:ss " };

  it("offers only families an import reads, each one the systems page knows", () => {
    for (const f of IMPORT_FAMILIES) expect(DRIVER_TYPES).toContain(f);
    expect(IMPORT_FAMILIES).not.toContain("x_ui_vaxilu");
    expect(IMPORT_FAMILIES).not.toContain("mikrotik_user_manager");
  });

  it("sends the origin to billing and the whole address, web path too, to the vault", () => {
    expect(connectFormErrors(filled, null)).toEqual({});
    expect(sourceLoginOf(filled)).toEqual({
      sourceAddress: "https://old.example.com:8443",
      login: { apiBaseUrl: "https://old.example.com:8443/dashboard", login: "admin:p:ss " },
    });
  });

  it("asks Hiddify for its API key, and sends a subscription address only when given", () => {
    const hiddify = { ...filled, family: "hiddify" as const, apiKey: "k-1", clientBaseUrl: "https://sub.example.com/x" };
    expect(connectFormErrors(hiddify, null)).toEqual({});
    expect(sourceLoginOf(hiddify).login).toEqual({ apiBaseUrl: "https://old.example.com:8443/dashboard", clientBaseUrl: "https://sub.example.com/x", login: "k-1" });
    expect(Object.keys(connectFormErrors({ ...hiddify, apiKey: "" }, null))).toEqual(["apiKey"]);
  });

  it("refuses an address that is not an absolute http(s) one", () => {
    expect(Object.keys(connectFormErrors({ ...filled, address: "old.example.com" }, null))).toEqual(["address"]);
    expect(Object.keys(connectFormErrors({ ...filled, address: "ftp://old.example.com" }, null))).toEqual(["address"]);
    expect(Object.keys(connectFormErrors({ ...filled, clientBaseUrl: "sub" }, null))).toEqual(["clientBaseUrl"]);
  });

  it("holds a login for a run to that run's panel", () => {
    expect(connectFormErrors(filled, run())).toEqual({});
    expect(Object.keys(connectFormErrors({ ...filled, address: "https://other.example.com:8443/dashboard" }, run()))).toEqual(["address"]);
  });
});

describe("the mapping", () => {
  const products: UsersCatalogProduct[] = [
    {
      id: "p-1",
      nameKey: "catalog.monthly",
      isActive: true,
      variants: [
        { id: "v-pre", sku: "M-30", nameKey: null, isActive: true, billingMode: "prepaid" },
        { id: "v-meter", sku: "M-PAYG", nameKey: null, isActive: true, billingMode: "metered" },
        { id: "v-off", sku: "M-OLD", nameKey: null, isActive: false, billingMode: "prepaid" },
      ],
    },
    { id: "p-off", nameKey: "catalog.off", isActive: false, variants: [{ id: "v-p-off", sku: "X", nameKey: null, isActive: true, billingMode: "prepaid" }] },
  ];

  it("offers the active prepaid plans of active products, named in the reader's language", () => {
    expect(mappingOptions(products, { "catalog.monthly": "Monthly" })).toEqual([{ value: "v-pre", label: "Monthly · M-30" }]);
  });

  it("sends every inbound, an unchosen one as null", () => {
    const inbounds = [inbound, { ...inbound, inboundRemoteId: "2", variantId: "v-old" }];
    expect(mappingBody(inbounds, { "1": "v-pre" })).toEqual([
      { inboundRemoteId: "1", variantId: "v-pre" },
      { inboundRemoteId: "2", variantId: "v-old" },
    ]);
    expect(mappingBody(inbounds, { "2": "" })).toEqual([
      { inboundRemoteId: "1", variantId: null },
      { inboundRemoteId: "2", variantId: null },
    ]);
  });
});

describe("progress and the rollback window", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");

  it("counts the commit over what it will issue, skips left out", () => {
    expect(commitProgress(run({ status: "committing", plannedCreate: 30, plannedUpdate: 10, plannedSkip: 5, committedItems: 18, failedItems: 2 }))).toEqual({ done: 20, total: 40, percent: 50 });
    expect(commitProgress(run({ status: "committing" }))).toEqual({ done: 0, total: 0, percent: 100 });
  });

  it("offers the rollback with its days left, a part day counted whole, and never past its end", () => {
    expect(rollbackDaysLeft(run({ status: "committed", rollbackUntil: "2026-10-28T08:00:00Z" }), now)).toBe(7);
    expect(rollbackDaysLeft(run({ status: "committed", rollbackUntil: "2026-10-21T13:00:00Z" }), now)).toBe(1);
    expect(rollbackDaysLeft(run({ status: "committed", rollbackUntil: "2026-10-21T11:00:00Z" }), now)).toBeNull();
    expect(rollbackDaysLeft(run({ status: "rolled_back", rollbackUntil: "2026-10-28T08:00:00Z" }), now)).toBeNull();
  });
});

describe("where the page hears the run", () => {
  const owner = { userId: "u-1", tenant: { id: "platform" }, permissions: [REALTIME_TENANT_READ] };

  it("the owner on the platform's panel: their own user: channel, for this reseller's runs only", () => {
    const [live, ...rest] = migrationLiveOf(owner, "r-9");
    expect(rest).toEqual([]);
    expect(live.channel).toBe(userChannel("u-1"));
    expect(live.accepts({ tenantId: "r-9", runId: "run-1" })).toBe(true);
    expect(live.accepts({ tenantId: "r-other", runId: "run-1" })).toBe(false);
  });

  it("a seat of the reseller also hears the tenant: channel, for runs another admin started", () => {
    const seat = { ...owner, tenant: { id: "r-9" } };
    expect(migrationLiveOf(seat, "r-9").map((l) => l.channel)).toEqual([userChannel("u-1"), tenantChannel("r-9")]);
    expect(migrationLiveOf({ ...seat, permissions: [] }, "r-9").map((l) => l.channel)).toEqual([userChannel("u-1")]);
  });

  it("nothing before the session is known", () => {
    expect(migrationLiveOf(null, "r-9")).toEqual([]);
  });
});
