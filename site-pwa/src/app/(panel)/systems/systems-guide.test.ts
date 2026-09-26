import type { PanelGroup, PanelGroupMember, PanelInbound, PanelInbounds, SystemsPanel } from "@/lib/billing-api";
import { memberChoiceOf, validateMemberChoice, type MemberChoice } from "./_lib/member-settings";
import { attentionOf, guideOf, panelStatusOf } from "./_lib/systems-guide";

/**
 * The systems page for a first-time admin (F-027-ck). What breaks silently:
 *  - a guide that ticks a step the data does not show (a panel "ready" that
 *    was refused, a group "done" that no product sells on), so the admin
 *    stops one step early and nothing is sold;
 *  - a tab whose badge misses a panel that stopped, so the problem sits
 *    behind a tab nobody opens;
 *  - the member form's "same as the panel" sending a value instead of null —
 *    the member then stops following the panel, and a later panel change
 *    moves nothing on it — or "own inbounds" saved with none ticked, which
 *    billing reads as the shared pool.
 */
const panel = (over: Partial<SystemsPanel> = {}, review: Partial<SystemsPanel["review"]> = {}, health: Partial<SystemsPanel["health"]> = {}): SystemsPanel => ({
  id: "p-1",
  name: "de-1",
  driverType: "marzban",
  transport: "pull",
  role: "active",
  region: "de",
  ipAddress: null,
  apiBaseUrl: "https://de-1.example.com",
  clientBaseUrl: null,
  retiredAt: null,
  review: { reviewState: "accepted", connectionTestedAt: null, connectionTestFault: null, connectionTestDetail: null, duplicateOf: null, ...review },
  health: { panelState: "healthy", lastHealthyAt: null, lastSuccessfulCollectionAt: null, collectionHalted: false, openDriftEvents: 0, ...health },
  budget: { maxRequestsPerMinute: 60, blockedSince: null },
  radiusSecretConfigured: null,
  ...over,
});

const member = (over: Partial<PanelGroupMember> = {}): PanelGroupMember => ({
  groupId: "g-1",
  panelId: "p-1",
  inboundPlacement: null,
  maxClients: null,
  priority: null,
  weight: null,
  effective: {
    inboundPlacement: { value: "all", layer: "platform" },
    maxClients: { value: null, layer: "platform" },
    priority: { value: 0, layer: "platform" },
    weight: { value: 1, layer: "platform" },
  },
  inbounds: [],
  role: "primary",
  drainingSince: null,
  createdAt: "2026-09-25T10:00:00.000Z",
  panelName: "de-1",
  panelState: "healthy",
  reviewState: "accepted",
  lastHealthyAt: null,
  ...over,
});

const group = (over: Partial<PanelGroup> = {}): PanelGroup => ({
  id: "g-1",
  name: "Germany",
  strategy: "mirror",
  minHealthyPanels: 1,
  subscriptionTtlSeconds: 3600,
  createdAt: "2026-09-25T10:00:00.000Z",
  updatedAt: "2026-09-25T10:00:00.000Z",
  variantCount: 0,
  members: [],
  ...over,
});

const inbound = (remoteId: string): PanelInbound => ({
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
  assignedTo: null,
});

const view = (over: Partial<PanelInbounds> = {}): PanelInbounds => ({
  panelId: "p-1",
  inboundPlacement: "spread",
  maxClients: 300,
  priority: null,
  weight: null,
  effective: {
    inboundPlacement: { value: "spread", layer: "panel" },
    maxClients: { value: 300, layer: "panel" },
    priority: { value: 0, layer: "platform" },
    weight: { value: 1, layer: "platform" },
  },
  inboundsReadAt: "2026-09-25T10:00:00.000Z",
  users: 0,
  inbounds: [inbound("1"), inbound("2")],
  ...over,
});

describe("guideOf — each step ticked only by what the data shows", () => {
  const states = (panels: SystemsPanel[], groups: PanelGroup[]) => guideOf(panels, groups).steps.map((s) => `${s.step}:${s.state}`);

  it("starts at registering, with every later step still to do", () => {
    expect(states([], [])).toEqual(["register:current", "accepted:todo", "group:todo", "product:todo"]);
    expect(guideOf([], []).done).toBe(false);
  });

  it("a registered panel still waiting for its test is not yet accepted", () => {
    expect(states([panel({}, { reviewState: "pending" })], [])).toEqual(["register:done", "accepted:current", "group:todo", "product:todo"]);
  });

  it("a refused or an archived panel accepts nothing", () => {
    expect(states([panel({}, { reviewState: "refused" })], [])[1]).toBe("accepted:current");
    expect(states([panel({ retiredAt: "2026-09-25T10:00:00.000Z" })], [])[0]).toBe("register:current");
  });

  it("an empty group is not the group step; a group no product names is not the last", () => {
    const accepted = [panel()];
    expect(states(accepted, [group()])[2]).toBe("group:current");
    expect(states(accepted, [group({ members: [member()] })])).toEqual(["register:done", "accepted:done", "group:done", "product:current"]);
    const all = guideOf(accepted, [group({ members: [member()], variantCount: 1 })]);
    expect(all.done).toBe(true);
    expect(all.steps.every((s) => s.state === "done")).toBe(true);
  });

  it("a later step done out of order is still shown done, and the first undone is current", () => {
    // A group sold on while its only panel is still pending: step 2 is what is missing.
    expect(states([panel({}, { reviewState: "pending" })], [group({ members: [member()], variantCount: 2 })])).toEqual([
      "register:done",
      "accepted:current",
      "group:done",
      "product:done",
    ]);
  });
});

describe("panelStatusOf — one status per card, the worst first", () => {
  it("names each state once", () => {
    expect(panelStatusOf(panel())).toBe("ready");
    expect(panelStatusOf(panel({}, { reviewState: "accepted_low_trust" }))).toBe("limited");
    expect(panelStatusOf(panel({}, { reviewState: "pending" }))).toBe("testing");
    expect(panelStatusOf(panel({}, { reviewState: "refused" }))).toBe("refused");
    expect(panelStatusOf(panel({ retiredAt: "2026-09-25T10:00:00.000Z" }))).toBe("archived");
  });

  it("anything that stops sales on an accepted panel is a problem, not ready", () => {
    expect(panelStatusOf(panel({}, {}, { collectionHalted: true }))).toBe("problem");
    expect(panelStatusOf(panel({}, {}, { panelState: "down" }))).toBe("problem");
    expect(panelStatusOf(panel({}, {}, { panelState: "throttled_or_blocked" }))).toBe("problem");
    expect(panelStatusOf(panel({ budget: { maxRequestsPerMinute: 60, blockedSince: "2026-09-25T10:00:00.000Z" } }))).toBe("problem");
    expect(panelStatusOf(panel({ transport: "push", radiusSecretConfigured: false }))).toBe("problem");
  });

  it("refused outranks a stopped collection: the fix is the registration, not the collector", () => {
    expect(panelStatusOf(panel({}, { reviewState: "refused" }, { collectionHalted: true }))).toBe("refused");
  });
});

describe("attentionOf — a tab's badge counts what needs a hand", () => {
  it("counts refused and stopped panels, short groups, and open drift events", () => {
    const panels = [
      panel({ id: "a" }),
      panel({ id: "b" }, { reviewState: "refused" }),
      panel({ id: "c" }, {}, { collectionHalted: true, openDriftEvents: 2 }),
      panel({ id: "d" }, { reviewState: "pending" }),
      panel({ id: "e", retiredAt: "2026-09-25T10:00:00.000Z" }, { reviewState: "refused" }, { openDriftEvents: 5 }),
    ];
    const groups = [group({ id: "ok", members: [member()] }), group({ id: "short", minHealthyPanels: 2, members: [member()] })];
    expect(attentionOf(panels, groups)).toEqual({ panels: 2, groups: 1, reports: 2 });
  });

  it("is zero on a page with nothing wrong", () => {
    expect(attentionOf([panel()], [group({ members: [member()] })])).toEqual({ panels: 0, groups: 0, reports: 0 });
  });
});

describe("the member form — 'same as the panel' is said, not implied by an empty field", () => {
  it("opens on what the member holds: following the panel, or its own value", () => {
    expect(memberChoiceOf(member(), view())).toEqual({
      placementMode: "panel",
      placement: "spread",
      capMode: "panel",
      maxClients: "",
      inboundsMode: "pool",
      picked: [],
    });
    expect(memberChoiceOf(member({ inboundPlacement: "all", maxClients: 40, inbounds: ["2"] }), view())).toEqual({
      placementMode: "own",
      placement: "all",
      capMode: "own",
      maxClients: "40",
      inboundsMode: "own",
      picked: ["2"],
    });
  });

  const form = (over: Partial<MemberChoice> = {}): MemberChoice => ({ ...memberChoiceOf(member(), view()), ...over });

  it("an untouched form is refused before any call", () => {
    const out = validateMemberChoice(form(), member());
    expect(out.ok).toBe(false);
    expect(!out.ok && out.errors.form).toBeTruthy();
  });

  it("'own' sends the value; back to 'same as the panel' sends null, never the panel's number", () => {
    const own = validateMemberChoice(form({ placementMode: "own", placement: "all", capMode: "own", maxClients: "50" }), member());
    expect(own).toEqual({ ok: true, settings: { inboundPlacement: "all", maxClients: 50 }, inbounds: null });

    const back = validateMemberChoice(form(), member({ inboundPlacement: "all", maxClients: 50 }));
    expect(back).toEqual({ ok: true, settings: { inboundPlacement: null, maxClients: null }, inbounds: null });
  });

  it("an own cap must be a whole number from 1; empty is not 'no cap'", () => {
    for (const bad of ["", "0", "-3", "2.5", "x", "1000001"]) {
      const out = validateMemberChoice(form({ capMode: "own", maxClients: bad }), member());
      expect(!out.ok && out.errors.maxClients).toBeTruthy();
    }
  });

  it("own inbounds need at least one ticked; the pool is the empty set", () => {
    const none = validateMemberChoice(form({ inboundsMode: "own", picked: [] }), member());
    expect(!none.ok && none.errors.inbounds).toBeTruthy();

    expect(validateMemberChoice(form({ inboundsMode: "own", picked: ["2", "1", "2"] }), member())).toEqual({ ok: true, settings: null, inbounds: ["1", "2"] });
    expect(validateMemberChoice(form(), member({ inbounds: ["1"] }))).toEqual({ ok: true, settings: null, inbounds: [] });
  });

  it("the set is sent whole, in numeric order, and one equal to what the member holds is no change", () => {
    const m = member({ inbounds: ["2", "10"] });
    expect(validateMemberChoice(memberChoiceOf(m, view()), m).ok).toBe(false);
    expect(validateMemberChoice({ ...memberChoiceOf(m, view()), picked: ["10", "3", "2"] }, m)).toEqual({ ok: true, settings: null, inbounds: ["2", "3", "10"] });
  });

  it("an own cap may be as high as the schema allows, and an unchanged own value is not re-sent", () => {
    const m = member({ maxClients: 40, inboundPlacement: "spread" });
    expect(validateMemberChoice({ ...memberChoiceOf(m, view()), maxClients: "1000000" }, m)).toEqual({ ok: true, settings: { maxClients: 1_000_000 }, inbounds: null });
  });

  it("ticks left over from 'own' are dropped when the pool is chosen", () => {
    expect(validateMemberChoice(form({ inboundsMode: "pool", picked: ["1"] }), member({ inbounds: ["1"] }))).toEqual({ ok: true, settings: null, inbounds: [] });
  });
});
