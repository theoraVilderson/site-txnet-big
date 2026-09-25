import type { PanelGroup, SystemsPanel } from "@/lib/billing-api";
import {
  DELETE_OUTCOME_KEYS,
  addressChanged,
  groupDeleteBlock,
  groupsHolding,
  panelEditFormOf,
  validatePanelEdit,
  visiblePanels,
} from "./_lib/panel-lifecycle";
import { SYSTEMS_KEYS as K } from "./_lib/systems";

/**
 * A panel's life on the systems page (F-027-cb, billing
 * `contract.panel-lifecycle.md`). What breaks silently:
 *  - an edit that re-sends a field nobody touched — an unchanged address
 *    re-sent is harmless, but a form that normalises one (a trailing space, an
 *    empty link sent as "") would re-test a live panel and pause its billing;
 *  - an address change saved without the warning that collection pauses;
 *  - a push panel sent an API or link address billing refuses;
 *  - a delete offered on a panel a group still holds, or on a group with
 *    members or a variant — buttons that can only be refused;
 *  - archived panels mixed into the working list.
 */
const pull = (over: Partial<SystemsPanel> = {}): SystemsPanel =>
  ({
    id: "p1",
    name: "de-fra-1",
    region: "de",
    transport: "pull",
    ipAddress: null,
    apiBaseUrl: "https://fra.example.com:2053/panel",
    clientBaseUrl: null,
    retiredAt: null,
    budget: { maxRequestsPerMinute: 60, blockedSince: null },
    ...over,
  }) as SystemsPanel;

const push = (over: Partial<SystemsPanel> = {}) => pull({ transport: "push", apiBaseUrl: null, ipAddress: "10.0.0.1", ...over });

describe("editing a panel (F-027-by)", () => {
  it("sends only what changed", () => {
    const p = pull();
    const form = { ...panelEditFormOf(p), name: " de-fra-main ", maxRequestsPerMinute: "30" };
    expect(validatePanelEdit(form, p)).toEqual({ ok: true, body: { name: "de-fra-main", maxRequestsPerMinute: 30 }, credentials: null });
  });

  it("an untouched form is refused here, not re-sent", () => {
    const p = pull();
    expect(validatePanelEdit(panelEditFormOf(p), p)).toEqual({ ok: false, errors: { form: K.edit.unchanged } });
  });

  it("a new login alone is a change, sent untrimmed to its own route", () => {
    const p = pull();
    expect(validatePanelEdit({ ...panelEditFormOf(p), credentials: " root:pw " }, p)).toEqual({ ok: true, body: {}, credentials: " root:pw " });
  });

  it("an address change is said before the save; an unchanged one is not", () => {
    const p = pull();
    expect(addressChanged(panelEditFormOf(p), p)).toBe(false);
    expect(addressChanged({ ...panelEditFormOf(p), apiBaseUrl: "https://fra2.example.com" }, p)).toBe(true);
    expect(addressChanged({ ...panelEditFormOf(p), clientBaseUrl: "https://sub.example.com/x" }, p)).toBe(true);
    expect(addressChanged({ ...panelEditFormOf(p), name: "x" }, p)).toBe(false);
  });

  it("clears a link address with null, never an empty string", () => {
    const p = pull({ clientBaseUrl: "https://sub.example.com/x" });
    expect(validatePanelEdit({ ...panelEditFormOf(p), clientBaseUrl: "" }, p)).toMatchObject({ ok: true, body: { clientBaseUrl: null } });
  });

  it("a push panel is sent no API or link address, and must keep a valid IP", () => {
    const p = push();
    const form = { ...panelEditFormOf(p), ipAddress: "10.0.0.2", apiBaseUrl: "https://x.example.com", clientBaseUrl: "https://y.example.com" };
    expect(validatePanelEdit(form, p)).toEqual({ ok: true, body: { ipAddress: "10.0.0.2" }, credentials: null });
    expect(addressChanged(form, p)).toBe(false);
    expect(validatePanelEdit({ ...panelEditFormOf(p), ipAddress: "" }, p)).toMatchObject({ ok: false, errors: { ipAddress: K.register.invalid.ipAddress } });
  });

  it("holds billing's limits", () => {
    const p = pull();
    const bad = validatePanelEdit({ ...panelEditFormOf(p), name: "", region: "", apiBaseUrl: "ftp://x", maxRequestsPerMinute: "0" }, p);
    expect(bad).toEqual({
      ok: false,
      errors: {
        name: K.register.invalid.name,
        region: K.register.invalid.region,
        apiBaseUrl: K.register.invalid.apiBaseUrl,
        maxRequestsPerMinute: K.edit.invalidBudget,
      },
    });
  });
});

describe("deleting (F-027-bz, F-027-ca)", () => {
  const group = (over: Partial<PanelGroup>) => ({ id: "g", name: "Europe", members: [], variantCount: 0, ...over }) as unknown as PanelGroup;

  it("names the groups still holding a panel", () => {
    const groups = [group({ name: "Europe", members: [{ panelId: "p1" }] as PanelGroup["members"] }), group({ name: "Asia" })];
    expect(groupsHolding(pull(), groups)).toEqual(["Europe"]);
    expect(groupsHolding(pull({ id: "p2" }), groups)).toEqual([]);
  });

  it("says each outcome billing can answer", () => {
    expect(Object.keys(DELETE_OUTCOME_KEYS).sort()).toEqual(["archived", "deleted"]);
  });

  it("offers a group's delete only when it is empty and unsold", () => {
    expect(groupDeleteBlock(group({}))).toBeNull();
    expect(groupDeleteBlock(group({ members: [{ panelId: "p1" }] as PanelGroup["members"], variantCount: 2 }))).toEqual({
      key: K.groupsRemove.blockedMembers,
      n: 1,
    });
    expect(groupDeleteBlock(group({ variantCount: 2 }))).toEqual({ key: K.groupsRemove.blockedVariants, n: 2 });
  });

  it("keeps archived panels out of the working list unless asked, and after the live ones", () => {
    const panels = [pull({ id: "a", retiredAt: "2026-09-20T00:00:00Z" }), pull({ id: "b" })];
    expect(visiblePanels(panels, false).map((p) => p.id)).toEqual(["b"]);
    expect(visiblePanels(panels, true).map((p) => p.id)).toEqual(["b", "a"]);
  });
});
