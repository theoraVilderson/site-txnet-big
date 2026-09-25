import type { ConfigProtocol, PanelGroup, PanelGroupBody, PanelGroupMember, PanelGroupMemberRole, SystemsPanel } from "@/lib/billing-api";
import { SYSTEMS_KEYS } from "./systems";

/**
 * Panel groups on the systems page (F-027-bx): where a `network_access`
 * variant's Grants are placed. The routes and every write are billing's
 * (`contract.systems.md` rules 20–24); what a group does is network's
 * (`contract.groups.md`). Nothing here decides — it mirrors the schema and
 * says what fulfilment and the drain sweep will do with the answer.
 */
const K = SYSTEMS_KEYS.groups;

/**
 * `network.ConfigProtocol`, in the schema's order (C-09). Protocol names, not
 * prose: not translated. A group names none — its panels' picked inbounds do
 * (F-114-b) — so this is what a picked inbound can be.
 */
export const CONFIG_PROTOCOLS = [
  "vmess",
  "vless",
  "trojan",
  "shadowsocks",
  "hysteria2",
  "tuic",
  "wireguard",
  "openvpn",
  "pppoe",
] as const satisfies readonly ConfigProtocol[];

export const MEMBER_ROLE_KEYS: Record<PanelGroupMemberRole, string> = {
  primary: K.role.primary,
  replica: K.role.replica,
  drain: K.role.drain,
};

/** billing `traffic/group-drain.ts`: a drained config goes this many subscription lifetimes after its line stopped being served. */
export const DRAIN_TTL_MULTIPLE = 2;

// ── The group form ────────────────────────────────────────────────────────────

/**
 * `priority` and `weight` are not asked: `mirror` reads neither (groups
 * rule 7), and the other strategies have no fulfilment. The lifetime is asked
 * in minutes — the schema's 60 s to a week is whole minutes on this form.
 */
export type GroupForm = {
  name: string;
  minHealthyPanels: string;
  ttlMinutes: string;
};

export function emptyGroupForm(): GroupForm {
  return { name: "", minHealthyPanels: "1", ttlMinutes: "60" };
}

/** A group's own values. A lifetime that is not whole minutes shows as a fraction and is sent only if edited. */
export function groupFormOf(group: PanelGroup): GroupForm {
  return {
    name: group.name,
    minHealthyPanels: String(group.minHealthyPanels),
    ttlMinutes: String(group.subscriptionTtlSeconds / 60),
  };
}

export type GroupValidation =
  | { ok: true; body: PanelGroupBody }
  | { ok: false; errors: Partial<Record<keyof GroupForm, string>> };

const MAX_TTL_MINUTES = 7 * 24 * 60;

function wholeIn(value: string, min: number, max: number): number | null {
  const n = Number(value.trim());
  return value.trim() !== "" && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * billing's `createPanelGroupSchema`, or — with `original` — its
 * `updatePanelGroupSchema`: only the fields that differ from the group are
 * checked and sent, so a value set by SQL outside the schema is never re-sent
 * untouched, and an edit that changes nothing is refused here, not as a 400.
 */
export function validateGroup(form: GroupForm, original?: PanelGroup): GroupValidation {
  const errors: Partial<Record<keyof GroupForm, string>> = {};
  const was = original ? groupFormOf(original) : null;
  const touched = (field: keyof GroupForm) => !was || form[field].trim() !== was[field].trim();
  const body: PanelGroupBody = {};

  if (touched("name")) {
    const name = form.name.trim();
    if (name.length < 1 || name.length > 100) errors.name = K.invalid.name;
    else body.name = name;
  }
  if (touched("minHealthyPanels")) {
    const n = wholeIn(form.minHealthyPanels, 1, 100);
    if (n === null) errors.minHealthyPanels = K.invalid.minHealthyPanels;
    else body.minHealthyPanels = n;
  }
  if (touched("ttlMinutes")) {
    const n = wholeIn(form.ttlMinutes, 1, MAX_TTL_MINUTES);
    if (n === null) errors.ttlMinutes = K.invalid.ttlMinutes;
    else body.subscriptionTtlSeconds = n * 60;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (original && Object.keys(body).length === 0) return { ok: false, errors: { name: K.invalid.unchanged } };
  return { ok: true, body };
}

// ── Reading a group ───────────────────────────────────────────────────────────

/** Fulfilment's own test (groups rule 8): not `drain`, on an accepted panel that is `healthy`. */
export function memberPlaceable(member: PanelGroupMember): boolean {
  return (
    member.role !== "drain" &&
    (member.reviewState === "accepted" || member.reviewState === "accepted_low_trust") &&
    member.panelState === "healthy"
  );
}

/**
 * How many members a new config can be placed on, against the group's
 * minimum. A Grant is activated only once `minHealthyPanels` of its configs
 * are live (groups rule 10), so a group `short` of it sells Grants that wait.
 */
export function groupHealth(group: PanelGroup): { placeable: number; min: number; short: boolean } {
  const placeable = group.members.filter(memberPlaceable).length;
  return { placeable, min: group.minHealthyPanels, short: placeable < group.minHealthyPanels };
}

/** Registered panels a group does not hold yet, by name. A refused panel never serves: it is not offered. */
export function addablePanels(panels: readonly SystemsPanel[], group: PanelGroup): SystemsPanel[] {
  const held = new Set(group.members.map((m) => m.panelId));
  return panels
    .filter((p) => !held.has(p.id) && p.review.reviewState !== "refused")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Once: a second drain is 409 `already_draining`, and its clock is never restarted (billing rule 24). */
export function canDrain(member: PanelGroupMember): boolean {
  return member.role !== "drain";
}

/** A draining member goes on its own when the sweep has emptied it (groups rule 15). */
export function canRemove(member: PanelGroupMember): boolean {
  return member.role !== "drain";
}

/**
 * The earliest the sweep retires a draining member's configs: two lifetimes
 * from `drainingSince`. Later for a Grant whose replacement is served later,
 * and held while an active Grant has none (groups rule 14) — so "no sooner
 * than", never "at".
 */
export function drainEarliestAt(member: PanelGroupMember, group: PanelGroup): string | null {
  if (member.role !== "drain" || !member.drainingSince) return null;
  return new Date(Date.parse(member.drainingSince) + DRAIN_TTL_MULTIPLE * group.subscriptionTtlSeconds * 1000).toISOString();
}

/** A wait in the largest whole unit; minutes are rounded up, so the page never promises sooner than the sweep. */
export function waitOf(seconds: number): { key: string; n: number } {
  if (seconds >= 86400 && seconds % 86400 === 0) return { key: K.wait.days, n: seconds / 86400 };
  if (seconds >= 3600 && seconds % 3600 === 0) return { key: K.wait.hours, n: seconds / 3600 };
  return { key: K.wait.minutes, n: Math.ceil(seconds / 60) };
}
