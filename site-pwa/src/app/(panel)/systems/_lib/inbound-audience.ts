import { RealtimeEvents } from "@/generated/wire";
import type { EvictOrphans, InboundAudience, InboundAudienceBody, InboundReleaseBody, InboundSeller, PanelInbound, PanelInbounds, ReleaseMode } from "@/lib/billing-api";
import { SYSTEMS_KEYS } from "./systems";

/**
 * Who sells one inbound, each group's share, and taking groups off it
 * (F-027-eu -> billing F-027-ep/eq/es, ADR-0127). Nothing here decides: it
 * mirrors billing's three bodies — the audience, a listing's share, a release
 * — and says, from the page's own read (`sellers`), which groups would lose
 * the inbound with users there, which billing would refuse.
 */
const A = SYSTEMS_KEYS.audience;
const R = SYSTEMS_KEYS.release;

/** A release job's progress, pushed to the platform's tenant channel (billing `announceProgress`). */
export const RELEASE_EVENTS: readonly string[] = [RealtimeEvents.configMoveJobProgress];

/** billing's `capSchema` for a share: a whole number from 1, or none. */
const MAX_SHARE = 1_000_000;

/** billing's `reason` on a release. */
const MAX_REASON = 500;

export type AudienceForm = {
  audience: InboundAudience;
  /** The groups ticked when `listed`. */
  groups: string[];
  /** Each seller's share as typed, by group id; empty = none. */
  shares: Record<string, string>;
};

/** The error key a share is filed under. */
export const shareField = (groupId: string) => `share:${groupId}`;

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

export function audienceFormOf(i: PanelInbound): AudienceForm {
  return {
    audience: i.audience,
    groups: i.listedTo.map((g) => g.id),
    shares: Object.fromEntries(i.sellers.map((s) => [s.groupId, s.share === null ? "" : String(s.share)])),
  };
}

/** The row's one line: every group, or the groups listed (none = nobody new is placed there). */
export function soldBy(i: PanelInbound): { every: boolean; names: string[] } {
  return i.audience === "every_group" ? { every: true, names: [] } : { every: false, names: i.listedTo.map((g) => g.name) };
}

/** The groups that would sell it after the form: every member of the panel, or those ticked. */
function sellersAfter(form: AudienceForm, view: PanelInbounds): string[] {
  return form.audience === "every_group" ? view.members.map((m) => m.id) : form.groups;
}

/**
 * The sellers the form takes it from that have users there now — billing
 * refuses that save (`inbound_has_configs`, ADR-0127 decision 6) and the way
 * on is a release of exactly these groups.
 */
export function losing(form: AudienceForm, view: PanelInbounds, i: PanelInbound): InboundSeller[] {
  const after = new Set(sellersAfter(form, view));
  return i.sellers.filter((s) => s.clients > 0 && !after.has(s.groupId));
}

/** A release job running on this inbound, from any of its sellers: the page watches it. */
export function runningRelease(i: PanelInbound): string | null {
  return i.sellers.find((s) => s.releaseJobId !== null)?.releaseJobId ?? null;
}

/** A share as typed: `null` = none, `undefined` = not a share. */
function shareOf(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= MAX_SHARE ? n : undefined;
}

export type AudienceSave =
  | { ok: true; audience: InboundAudienceBody | null; shares: { groupId: string; maxClients: number | null }[] }
  | { ok: false; errors: Record<string, string> };

/**
 * Billing's audience `PUT` and share `PUT`s over what changed. A share is
 * sent only for a group that lists the inbound now and keeps it — billing has
 * no share on an every-group inbound (`listing_not_found`); one for a group
 * just ticked is set after its save. Nothing changed is refused here.
 */
export function validateAudience(form: AudienceForm, i: PanelInbound): AudienceSave {
  const errors: Record<string, string> = {};
  const changedAudience = form.audience !== i.audience || (form.audience === "listed" && !sameSet(form.groups, i.listedTo.map((g) => g.id)));
  const audience: InboundAudienceBody | null = !changedAudience
    ? null
    : form.audience === "every_group"
      ? { audience: "every_group" }
      : { audience: "listed", groups: [...new Set(form.groups)].sort() };

  const shares: { groupId: string; maxClients: number | null }[] = [];
  const keeps = (groupId: string) => form.audience === "listed" && form.groups.includes(groupId);
  for (const s of i.sellers) {
    if (i.audience !== "listed" || !keeps(s.groupId)) continue;
    const share = shareOf(form.shares[s.groupId] ?? "");
    if (share === undefined) errors[shareField(s.groupId)] = A.invalid.share;
    else if (share !== s.share) shares.push({ groupId: s.groupId, maxClients: share });
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (!audience && shares.length === 0) return { ok: false, errors: { form: SYSTEMS_KEYS.inbounds.invalid.unchanged } };
  return { ok: true, audience, shares };
}

export type ReleaseForm = { mode: ReleaseMode; orphans: EvictOrphans | null; reason: string };

export type ReleaseValidation = { ok: true; body: InboundReleaseBody } | { ok: false; errors: Record<string, string> };

/**
 * Billing's `releaseInboundSchema`: the groups, the way out, a reason, and —
 * for `empty` only — what a user left with no config gets. `requestId` is
 * minted once per confirm by the caller, so a double click is one job.
 */
export function validateRelease(form: ReleaseForm, groups: string[], requestId: string): ReleaseValidation {
  const errors: Record<string, string> = {};
  const reason = form.reason.trim();
  if (reason.length === 0 || reason.length > MAX_REASON) errors.reason = R.invalid.reason;
  if (form.mode === "empty" && form.orphans === null) errors.orphans = R.invalid.orphans;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const body: InboundReleaseBody = { requestId, groups, mode: form.mode, reason };
  if (form.mode === "empty" && form.orphans) body.orphans = form.orphans;
  return { ok: true, body };
}
