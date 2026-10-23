/**
 * The import page's in-place start (F-1601-c; entitlement
 * `contract.import-in-place.md`): a MikroTik User Manager is read from the
 * reseller's own registered router, never through an address and a login
 * typed for the run. The rules held are the page's own:
 *
 *  - an in-place run that the read sent back is read again, never sent to a
 *    login form it has no use for; with profiles read it is the mapping;
 *  - a router is offered for a run only once its test accepted it;
 *  - the router's address is its origin: the driver adds `/rest` itself, so
 *    a path would be read as `/rest/rest/…` and never answer;
 *  - the login is composed as the register form's, the way network reads it;
 *  - a router's verdict is heard on the reseller's `tenant:` channel, which
 *    only a seat of the reseller holds.
 */
import { describe, expect, it } from "vitest";
import type { MigrationRun, ResellerRouter } from "@/lib/billing-api";
import { tenantChannel } from "@/lib/realtime";
import { REALTIME_TENANT_READ } from "@/lib/tenant-channel";
import { MIGRATION_KEYS as K, stageOf } from "./_lib/migration";
import { emptyRouterForm, isInPlaceFamily, isPickable, recheckKeyOf, routerBodyOf, routerFormErrors, routersChannelOf } from "./_lib/migration-router";

const run = (over: Partial<MigrationRun> = {}): MigrationRun => ({
  id: "run-1",
  kind: "panel",
  sourceFamily: "mikrotik_user_manager",
  sourceAddress: "https://203.0.113.9",
  sourcePanelId: "panel-1",
  status: "draft",
  failureReason: null,
  plannedCreate: 0,
  plannedUpdate: 0,
  plannedSkip: 0,
  committedItems: 0,
  failedItems: 0,
  rollbackUntil: null,
  snapshotsPurgedAt: null,
  userId: null,
  variantId: null,
  createdAt: "2026-10-23T08:00:00Z",
  updatedAt: "2026-10-23T08:00:00Z",
  inbounds: [],
  ...over,
});

const router = (reviewState: ResellerRouter["reviewState"]): ResellerRouter => ({
  id: "panel-1",
  name: "home",
  family: "mikrotik_user_manager",
  address: "https://203.0.113.9",
  reviewState,
  fault: null,
  testedAt: null,
});

describe("an in-place run's steps", () => {
  it("is read again when the read sent it back, and mapped once its profiles are read", () => {
    expect(stageOf(run({ failureReason: "source_unavailable" }))).toBe("retry");
    expect(stageOf(run())).toBe("retry");
    const profile = { inboundRemoteId: "monthly-20G", tag: "monthly-20G", protocol: "", clientCount: 3, variantId: null };
    expect(stageOf(run({ inbounds: [profile], failureReason: "inbounds_unmapped" }))).toBe("mapping");
  });

  it("names its read again as the router's, a link's and a file's as their own", () => {
    expect(recheckKeyOf(run())).toBe(K.router.retry);
    expect(recheckKeyOf(run({ kind: "link", sourcePanelId: null }))).toBe(K.link.retry);
    expect(recheckKeyOf(run({ kind: "csv", sourcePanelId: null }))).toBe(K.csv.recheck);
  });
});

describe("the reseller's routers", () => {
  it("knows which families are imported in place", () => {
    expect(isInPlaceFamily("mikrotik_user_manager")).toBe(true);
    expect(isInPlaceFamily("marzban")).toBe(false);
  });

  it("offers a router for a run only once its test accepted it", () => {
    expect(isPickable(router("accepted"))).toBe(true);
    expect(isPickable(router("accepted_low_trust"))).toBe(true);
    expect(isPickable(router("pending"))).toBe(false);
    expect(isPickable(router("refused"))).toBe(false);
  });

  it("asks a name, the router's bare address and a login whose user has no colon", () => {
    expect(Object.keys(routerFormErrors(emptyRouterForm())).sort()).toEqual(["address", "name", "password", "username"]);
    const filled = { ...emptyRouterForm(), name: "home", address: "https://203.0.113.9", username: "api", password: "p" };
    expect(routerFormErrors(filled)).toEqual({});
    expect(routerFormErrors({ ...filled, address: "https://203.0.113.9/rest" }).address).toBe(K.router.invalid.addressPath);
    expect(routerFormErrors({ ...filled, address: "ftp://203.0.113.9" }).address).toBe(K.invalid.address);
    expect(routerFormErrors({ ...filled, username: "a:pi" }).username).toBeDefined();
  });

  it("sends the origin, the trimmed name and the login as network reads it", () => {
    const form = { ...emptyRouterForm(), name: " home ", address: " https://203.0.113.9:8443/ ", username: "api", password: " p:ss " };
    expect(routerBodyOf(form, "mikrotik_user_manager")).toEqual({
      family: "mikrotik_user_manager",
      name: "home",
      apiBaseUrl: "https://203.0.113.9:8443",
      credentials: "api: p:ss ",
    });
  });

  it("hears a router's verdict on the reseller's tenant: channel, held only by its seats", () => {
    const seat = { userId: "u-2", tenant: { id: "r-9" }, permissions: [REALTIME_TENANT_READ] };
    expect(routersChannelOf(seat, "r-9")).toBe(tenantChannel("r-9"));
    expect(routersChannelOf({ ...seat, tenant: { id: "platform" } }, "r-9")).toBeNull();
    expect(routersChannelOf(null, "r-9")).toBeNull();
  });
});
