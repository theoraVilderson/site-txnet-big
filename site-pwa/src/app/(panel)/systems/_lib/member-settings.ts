import type { InboundPlacement, MemberSellingBody, PanelGroupMember, PanelInbound, PanelInbounds, SellingLayer } from "@/lib/billing-api";
import { sellable } from "./panel-inbounds";
import { SYSTEMS_KEYS } from "./systems";

/**
 * How one group sells on one panel (F-027-ci -> billing F-027-cg/ch): the
 * member's own selling settings over its panel's, and the inbounds its
 * membership holds. The resolution and every write are billing's
 * (`contract.systems.md` rules 24b–24c); what fulfilment does with them is
 * network's (`contract.inbounds.md` rules 3a and 4a). Nothing here decides.
 */
const K = SYSTEMS_KEYS;

/** billing `SellingLayer`: where a value in force was set. */
export const LAYER_KEYS: Record<SellingLayer, string> = {
  member: K.layer.member,
  panel: K.layer.panel,
  platform: K.layer.platform,
};

/** billing's `capSchema`. */
const MAX_CAP = 1_000_000;

/**
 * The member sheet (F-027-ck): each setting says outright whether it follows
 * the panel or is this group's own, instead of an empty field meaning
 * "inherit". `priority` / `weight` are not asked — no fulfilled strategy reads
 * them (panel-web rule 11). "Same as the panel" is null on the wire; there is
 * no "no cap" of the member's own, since a member cannot lift a capped panel
 * (network rule 4a). Inbounds: the panel's shared ones (`[]`) or this group's
 * own set, which then only it sells on (billing rule 24c).
 */
export type MemberChoice = {
  placementMode: "panel" | "own";
  placement: InboundPlacement;
  capMode: "panel" | "own";
  maxClients: string;
  inboundsMode: "pool" | "own";
  picked: string[];
};

/** What the member holds; an "own" value starts from what is in force (the panel's, once read), so switching to it changes nothing yet. */
export function memberChoiceOf(member: PanelGroupMember, panel: PanelInbounds | null): MemberChoice {
  return {
    placementMode: member.inboundPlacement === null ? "panel" : "own",
    placement: member.inboundPlacement ?? panel?.effective.inboundPlacement.value ?? member.effective.inboundPlacement.value,
    capMode: member.maxClients === null ? "panel" : "own",
    maxClients: member.maxClients === null ? "" : String(member.maxClients),
    inboundsMode: member.inbounds.length > 0 ? "own" : "pool",
    picked: member.inbounds,
  };
}

export type MemberChoiceErrors = Partial<Record<"maxClients" | "inbounds" | "form", string>>;

/** Two writes behind one save: the settings `PATCH` (only what differs) and the inbounds `PUT` (the whole set), each null when unchanged. */
export type MemberChoiceValidation =
  | { ok: true; settings: MemberSellingBody | null; inbounds: string[] | null }
  | { ok: false; errors: MemberChoiceErrors };

const byRemoteId = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

export function validateMemberChoice(form: MemberChoice, member: PanelGroupMember): MemberChoiceValidation {
  const errors: MemberChoiceErrors = {};
  const settings: MemberSellingBody = {};

  const placement = form.placementMode === "panel" ? null : form.placement;
  if (placement !== member.inboundPlacement) settings.inboundPlacement = placement;

  let cap: number | null = null;
  if (form.capMode === "own") {
    const n = Number(form.maxClients.trim());
    if (form.maxClients.trim() === "" || !(Number.isInteger(n) && n >= 1 && n <= MAX_CAP)) errors.maxClients = K.member.invalid.cap;
    else cap = n;
  }
  if (!errors.maxClients && cap !== member.maxClients) settings.maxClients = cap;

  const next = form.inboundsMode === "pool" ? [] : [...new Set(form.picked)].sort(byRemoteId);
  if (form.inboundsMode === "own" && next.length === 0) errors.inbounds = K.member.invalid.pickOne;
  const held = [...member.inbounds].sort(byRemoteId);
  const inboundsChanged = next.length !== held.length || next.some((id, i) => id !== held[i]);

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const hasSettings = Object.keys(settings).length > 0;
  if (!hasSettings && !inboundsChanged) return { ok: false, errors: { form: K.inbounds.invalid.unchanged } };
  return { ok: true, settings: hasSettings ? settings : null, inbounds: inboundsChanged ? next : null };
}

export type InboundChoice = {
  inbound: PanelInbound;
  /** Another group holding it: shown, never offered (billing `inbound_assigned_elsewhere`). */
  heldBy: { id: string; name: string } | null;
  /** Fulfilment loads only `sold`, enabled inbounds (network rule 2): ticking this one sells nothing yet. */
  takesNobody: boolean;
};

/**
 * What a membership can be given: every sellable inbound, plus any it holds
 * that stopped being sellable, so it can still be let go. Billing refuses to
 * assign an unsellable one (`inbound_not_sellable`).
 */
export function inboundChoices(view: PanelInbounds, groupId: string): InboundChoice[] {
  return view.inbounds
    .filter((i) => sellable(i) || i.assignedTo?.id === groupId)
    .map((i) => ({
      inbound: i,
      heldBy: i.assignedTo && i.assignedTo.id !== groupId ? i.assignedTo : null,
      takesNobody: !i.sold || !i.enabled || !sellable(i),
    }));
}

/**
 * The membership places nobody on this panel: nothing it sells is live — its
 * own set when it has one (an assignment replaces the pool), else the pool,
 * the `sold` inbounds no group holds (network rule 3a).
 */
export function sellsNobody(view: PanelInbounds, member: PanelGroupMember): boolean {
  const own = new Set(member.inbounds);
  const sells = (i: PanelInbound) => (own.size > 0 ? own.has(i.remoteId) : i.assignedTo === null);
  return !view.inbounds.some((i) => sells(i) && i.sold && i.enabled && sellable(i));
}
