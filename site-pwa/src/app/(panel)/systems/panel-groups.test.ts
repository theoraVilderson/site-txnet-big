import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PanelGroup, PanelGroupMember, SystemsPanel } from "@/lib/billing-api";
import {
  CONFIG_PROTOCOLS,
  DRAIN_TTL_MULTIPLE,
  MEMBER_ROLE_KEYS,
  addablePanels,
  canDrain,
  canRemove,
  drainEarliestAt,
  emptyGroupForm,
  groupFormOf,
  groupHealth,
  memberPlaceable,
  validateGroup,
  waitOf,
} from "./_lib/panel-groups";
import { SYSTEMS_KEYS as K } from "./_lib/systems";

/**
 * Panel groups on the systems page (F-027-bx, billing rules 20–24, network
 * `contract.groups.md`). What breaks silently:
 *  - a protocol or member role the database can hold with no entry here;
 *  - a form that sends what `createPanelGroupSchema` refuses, or an edit that
 *    rewrites a field nobody touched (a legacy TTL outside the schema's range
 *    would then refuse the whole edit);
 *  - a group that reads as able to sell while fewer members can be placed on
 *    than its `minHealthyPanels` — a Grant sold there never activates;
 *  - a drain whose stated wait is not the sweep's (`2 × subscriptionTtlSeconds`);
 *  - remove or drain offered on a member already draining.
 */
const REPO = join(__dirname, "../../../../..");
const PRISMA = readFileSync(join(REPO, "txnet-backend/prisma/domains/network.prisma"), "utf8");

function prismaEnum(name: string): string[] {
  const block = new RegExp(`enum ${name} \\{([\\s\\S]*?)\\}`).exec(PRISMA);
  if (!block) throw new Error(`enum ${name} is gone from network.prisma — this test is stale`);
  return block[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[a-z_0-9]+$/.test(l));
}

const member = (over: Partial<PanelGroupMember> = {}): PanelGroupMember => ({
  groupId: "g-1",
  panelId: "p-1",
  priority: 0,
  weight: 1,
  role: "primary",
  drainingSince: null,
  createdAt: "2026-09-25T10:00:00.000Z",
  panelName: "de-1",
  panelState: "healthy",
  reviewState: "accepted",
  lastHealthyAt: "2026-09-25T10:00:00.000Z",
  ...over,
});

const group = (over: Partial<PanelGroup> = {}): PanelGroup => ({
  id: "g-1",
  name: "Germany",
  strategy: "mirror",
  minHealthyPanels: 1,
  subscriptionTtlSeconds: 3600,
  protocol: "vless",
  createdAt: "2026-09-25T10:00:00.000Z",
  updatedAt: "2026-09-25T10:00:00.000Z",
  variantCount: 0,
  members: [],
  ...over,
});

describe("the closed sets, from their declared home", () => {
  it("ConfigProtocol and PanelGroupMemberRole", () => {
    expect([...CONFIG_PROTOCOLS].sort()).toEqual(prismaEnum("ConfigProtocol").sort());
    expect(Object.keys(MEMBER_ROLE_KEYS).sort()).toEqual(prismaEnum("PanelGroupMemberRole").sort());
  });

  it("the drain wait is the sweep's multiple", () => {
    const drain = readFileSync(join(REPO, "txnet-backend/billing-service/src/app/traffic/group-drain.ts"), "utf8");
    expect(/export const DRAIN_TTL_MULTIPLE = (\d+);/.exec(drain)?.[1]).toBe(String(DRAIN_TTL_MULTIPLE));
  });
});

describe("validateGroup mirrors createPanelGroupSchema / updatePanelGroupSchema", () => {
  const form = (over: Partial<ReturnType<typeof emptyGroupForm>> = {}) => ({ ...emptyGroupForm(), name: " Germany ", ...over });

  it("creates with every field, the lifetime asked in minutes and sent in seconds", () => {
    expect(validateGroup(form({ ttlMinutes: "30", minHealthyPanels: "2", protocol: "trojan" }))).toEqual({
      ok: true,
      body: { name: "Germany", minHealthyPanels: 2, subscriptionTtlSeconds: 1800, protocol: "trojan" },
    });
  });

  it.each([
    ["name", { name: "  " }],
    ["name", { name: "x".repeat(101) }],
    ["minHealthyPanels", { minHealthyPanels: "0" }],
    ["minHealthyPanels", { minHealthyPanels: "101" }],
    ["minHealthyPanels", { minHealthyPanels: "1.5" }],
    ["ttlMinutes", { ttlMinutes: "0" }],
    ["ttlMinutes", { ttlMinutes: String(7 * 24 * 60 + 1) }],
    ["ttlMinutes", { ttlMinutes: "" }],
  ] as const)("refuses %s = %j", (field, over) => {
    const checked = validateGroup(form(over));
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(Object.keys(checked.errors)).toEqual([field]);
  });

  it("an edit sends only what changed, and nothing changed is refused here", () => {
    const g = group({ subscriptionTtlSeconds: 90, minHealthyPanels: 2 });
    const f = groupFormOf(g);
    expect(validateGroup(f, g)).toEqual({ ok: false, errors: { name: K.groups.invalid.unchanged } });
    // A lifetime set by SQL outside the schema (90 s is not whole minutes) is never re-sent untouched.
    expect(validateGroup({ ...f, protocol: "trojan" }, g)).toEqual({ ok: true, body: { protocol: "trojan" } });
    expect(validateGroup({ ...f, ttlMinutes: "2" }, g)).toEqual({ ok: true, body: { subscriptionTtlSeconds: 120 } });
  });
});

describe("what fulfilment can place on (groups rule 8)", () => {
  it("a member that is not drain, on an accepted and healthy panel", () => {
    expect(memberPlaceable(member())).toBe(true);
    expect(memberPlaceable(member({ reviewState: "accepted_low_trust" }))).toBe(true);
    expect(memberPlaceable(member({ reviewState: "pending" }))).toBe(false);
    expect(memberPlaceable(member({ panelState: "degraded" }))).toBe(false);
    expect(memberPlaceable(member({ role: "drain", drainingSince: "2026-09-25T10:00:00.000Z" }))).toBe(false);
  });

  it("a group short of its minimum says so: a Grant sold there does not activate", () => {
    const g = group({ minHealthyPanels: 2, members: [member(), member({ panelId: "p-2", panelState: "down" })] });
    expect(groupHealth(g)).toEqual({ placeable: 1, min: 2, short: true });
    expect(groupHealth({ ...g, minHealthyPanels: 1 })).toEqual({ placeable: 1, min: 1, short: false });
  });
});

describe("adding and draining a member", () => {
  const panel = (id: string, name: string, reviewState: SystemsPanel["review"]["reviewState"] = "accepted") =>
    ({ id, name, review: { reviewState } }) as SystemsPanel;

  it("offers registered panels not yet in the group, never a refused one", () => {
    const g = group({ members: [member({ panelId: "p-1" })] });
    const panels = [panel("p-3", "zz"), panel("p-1", "in"), panel("p-2", "aa", "pending"), panel("p-4", "no", "refused")];
    expect(addablePanels(panels, g).map((p) => p.id)).toEqual(["p-2", "p-3"]);
  });

  it("a draining member is neither drained again nor removed: the sweep takes it", () => {
    expect(canDrain(member())).toBe(true);
    expect(canRemove(member())).toBe(true);
    const draining = member({ role: "drain", drainingSince: "2026-09-25T10:00:00.000Z" });
    expect(canDrain(draining)).toBe(false);
    expect(canRemove(draining)).toBe(false);
  });

  it("states the least wait from drainingSince, as the sweep counts it", () => {
    const g = group({ subscriptionTtlSeconds: 3600 });
    expect(drainEarliestAt(member({ role: "drain", drainingSince: "2026-09-25T10:00:00.000Z" }), g)).toBe("2026-09-25T12:00:00.000Z");
    expect(drainEarliestAt(member(), g)).toBeNull();
  });

  it("says a wait in the largest whole unit", () => {
    expect(waitOf(7200)).toEqual({ key: K.groups.wait.hours, n: 2 });
    expect(waitOf(2 * 86400)).toEqual({ key: K.groups.wait.days, n: 2 });
    expect(waitOf(180)).toEqual({ key: K.groups.wait.minutes, n: 3 });
    expect(waitOf(150)).toEqual({ key: K.groups.wait.minutes, n: 3 });
  });
});
