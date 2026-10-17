import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ApiError } from "@/lib/api-error";
import type { PanelGroupMember, PanelInbound, PanelInbounds } from "@/lib/billing-api";
import {
  LAYER_KEYS,
  inboundChoices,
  sellsNobody,
} from "./_lib/member-settings";
import { SYSTEMS_KEYS as K, refusalSentence } from "./_lib/systems";
import { REFUSAL_KEYS } from "./_lib/systems-refusals";

/**
 * A member's overrides, its inbounds, and the refusals that name a holder
 * (F-027-ci -> billing F-027-cg/ch/cd, network `contract.inbounds.md` rules
 * 3a and 4a). What breaks silently:
 *  - a value shown without the layer it came from, so an admin edits the panel
 *    to change what one member overrides, and nothing moves;
 *  - an override edit that re-sends settings nobody touched, or that sends
 *    "no cap" where the admin meant "inherit" (a member cannot lift a panel's cap);
 *  - an inbound offered to one group while another holds it, or one ticked
 *    that fulfilment will never place on, read as selling;
 *  - a duplicate or held-elsewhere refusal that says "another" when the page
 *    could say which, or names a holder the reader cannot see.
 */
const REPO = join(__dirname, "../../../../..");

const member = (over: Partial<PanelGroupMember> = {}): PanelGroupMember => ({
  groupId: "g-1",
  panelId: "p-1",
  inboundPlacement: null,
  maxClients: null,
  priority: null,
  weight: null,
  inboundsPerBuyer: null,
  effective: {
    inboundPlacement: { value: "all", layer: "platform" },
    maxClients: { value: null, layer: "platform" },
    priority: { value: 0, layer: "platform" },
    weight: { value: 1, layer: "platform" },
    inboundsPerBuyer: { value: 2, layer: "platform" },
  },
  inbounds: [],
  role: "primary",
  drainingSince: null,
  evictedAt: null,
  evictOrphans: null,
  evictedBy: null,
  heldGrants: null,
  createdAt: "2026-09-25T10:00:00.000Z",
  panelName: "de-1",
  panelState: "healthy",
  reviewState: "accepted",
  lastHealthyAt: "2026-09-25T10:00:00.000Z",
  ...over,
});

const inbound = (remoteId: string, over: Partial<PanelInbound> = {}): PanelInbound => ({
  remoteId,
  tag: `in-${remoteId}`,
  protocol: "vless",
  port: 443,
  host: "",
  enabled: true,
  goneAt: null,
  seenAt: "2026-09-25T10:00:00.000Z",
  sold: true,
  maxClients: null,
  clients: 0,
  audience: "every_group",
  listedTo: [],
  sellers: [],
  ...over,
});

/** Listed to the groups named (F-027-ep). */
const listed = (...groups: { id: string; name: string }[]): Partial<PanelInbound> => ({ audience: "listed", listedTo: groups });

const view = (inbounds: PanelInbound[]): PanelInbounds => ({
  panelId: "p-1",
  inboundPlacement: null,
  maxClients: null,
  priority: null,
  weight: null,
  inboundsPerBuyer: null,
  effective: member().effective,
  inboundsReadAt: "2026-09-25T10:00:00.000Z",
  users: 0,
  members: [],
  inbounds,
});

describe("the layer a value comes from", () => {
  it("has a sentence for every layer billing's resolver names", () => {
    const src = readFileSync(join(REPO, "txnet-backend/billing-service/src/app/traffic/selling-settings.ts"), "utf8");
    const m = /export type SellingLayer =([^;]*);/.exec(src);
    if (!m) throw new Error("SellingLayer is no longer a literal union — this test is stale");
    expect(Object.keys(LAYER_KEYS).sort()).toEqual([...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort());
  });
});

describe("the inbounds a membership sells", () => {
  it("offers what a buyer can be placed on, and what it holds even once gone, so it can be let go", () => {
    const v = view([inbound("1"), inbound("2", { goneAt: "2026-09-25T11:00:00.000Z" }), inbound("3", { protocol: null }), inbound("4", { goneAt: "2026-09-25T11:00:00.000Z", ...listed({ id: "g-1", name: "Germany" }) })]);
    expect(inboundChoices(v, "g-1", "en").map((c) => c.inbound.remoteId)).toEqual(["1", "4"]);
  });

  it("offers one another group lists, naming whom it is shared with (ADR-0127)", () => {
    const v = view([inbound("1", listed({ id: "g-2", name: "Gaming" })), inbound("2", listed({ id: "g-1", name: "Germany" }))]);
    const [shared, mine] = inboundChoices(v, "g-1", "en");
    expect(shared).toMatchObject({ sharedWith: "Gaming", everyGroup: false });
    expect(mine).toMatchObject({ sharedWith: "" });
  });

  it("marks one fulfilment will not place on: not ticked for sale on the panel, or disabled there", () => {
    const v = view([inbound("1"), inbound("2", { sold: false }), inbound("3", { enabled: false })]);
    expect(inboundChoices(v, "g-1", "en").map((c) => c.takesNobody)).toEqual([false, true, true]);
  });

  it("says when a membership places nobody on the panel: its listings plus the every-group ones have nothing live", () => {
    const pool = view([inbound("1", listed({ id: "g-2", name: "Gaming" })), inbound("2", { sold: false })]);
    expect(sellsNobody(pool, member())).toBe(true);
    expect(sellsNobody(view([inbound("1")]), member())).toBe(false);
    // A listing adds to the every-group inbounds (F-027-ep): a live one of either sells.
    const own = view([inbound("1", { sold: false }), inbound("2", { enabled: false, ...listed({ id: "g-1", name: "Germany" }) })]);
    expect(sellsNobody(own, member({ inbounds: ["2"] }))).toBe(true);
    expect(sellsNobody(view([inbound("1"), inbound("2", listed({ id: "g-1", name: "Germany" }))]), member({ inbounds: ["2"] }))).toBe(false);
  });
});

describe("a refusal that names its holder", () => {
  const names = {
    panel: (id: string) => (id === "p-9" ? "Frankfurt 1" : null),
    group: (id: string) => (id === "g-2" ? "Gaming" : null),
  };
  const refused = (reason: string, facts: Record<string, string | number> = {}) => new ApiError("x", { status: 409, reason, facts });

  it("has a sentence for an inbound a group would lose with users there", () => {
    expect(REFUSAL_KEYS).toHaveProperty("inbound_has_configs");
  });

  it("names the panel already registered at the address, from the page's own list", () => {
    expect(refusalSentence(refused("panel_already_registered", { panelId: "p-9" }), names)).toEqual({
      key: K.refusalsNamed.panel_already_registered,
      vars: { panel: "Frankfurt 1" },
    });
  });

  it("counts the configs on an inbound a group would lose", () => {
    expect(refusalSentence(refused("inbound_has_configs", { remoteId: "1", configs: 4 }), names)).toEqual({
      key: K.refusalsNamed.inbound_has_configs,
      vars: { inbound: "1", configs: "4" },
    });
  });

  it("falls back to the plain sentence for a holder the reader cannot see, or none sent (F-027-cj, a lost race)", () => {
    expect(refusalSentence(refused("panel_already_registered", { panelId: "p-other" }), names)).toEqual({ key: K.refusals.panel_already_registered });
    expect(refusalSentence(refused("inbound_has_configs", { configs: 2 }), names)).toEqual({ key: K.refusals.inbound_has_configs });
    expect(refusalSentence(refused("not_found"), names)).toEqual({ key: K.refusals.not_found });
    expect(refusalSentence(new Error("boom"), names)).toBeNull();
  });
});
