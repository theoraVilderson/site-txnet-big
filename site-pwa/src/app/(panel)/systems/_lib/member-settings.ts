import type { InboundPlacement, MemberSellingBody, PanelGroupMember, PanelInbound, PanelInbounds, SellingLayer } from "@/lib/billing-api";
import { formatList } from "../../_lib/digits";
import { perBuyerOf, sellable } from "./panel-inbounds";
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
  /** K under `hrw` (F-027-di): the panel's, or this group's own. */
  perBuyerMode: "panel" | "own";
  perBuyer: string;
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
    perBuyerMode: member.inboundsPerBuyer === null ? "panel" : "own",
    perBuyer: String(member.inboundsPerBuyer ?? panel?.effective.inboundsPerBuyer.value ?? member.effective.inboundsPerBuyer.value),
  };
}

/** K is asked only where the placement in force for this member is `hrw`: its own, else the panel's. */
export function perBuyerAsked(form: MemberChoice, panel: PanelInbounds | null): boolean {
  const placement = form.placementMode === "own" ? form.placement : panel?.effective.inboundPlacement.value;
  return placement === "hrw";
}

export type MemberChoiceErrors = Partial<Record<"maxClients" | "perBuyer" | "inbounds" | "form", string>>;

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

  // "Same as the panel" is null on the wire, whatever the field still holds.
  let perBuyer: number | null = null;
  if (form.perBuyerMode === "own") {
    const k = perBuyerOf(form.perBuyer);
    if (k === undefined || k === null) errors.perBuyer = K.member.invalid.perBuyer;
    else perBuyer = k;
  }
  if (!errors.perBuyer && perBuyer !== member.inboundsPerBuyer) settings.inboundsPerBuyer = perBuyer;

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
  /** The other groups listing it, as one list in the reader's language; ticking it here shares it with them (F-027-ep, «مشترک با …»). Empty: none. */
  sharedWith: string;
  /** Every group sells it: ticking it here makes it this group's alone, so the others lose it. */
  everyGroup: boolean;
  /** Fulfilment loads only `sold`, enabled inbounds (network rule 2): ticking this one sells nothing yet. */
  takesNobody: boolean;
};

const listsIt = (i: PanelInbound, groupId: string) => i.listedTo.some((g) => g.id === groupId);

/**
 * What a membership can list (F-027-ep, ADR-0127): every sellable inbound —
 * one other groups list is shared with them, an every-group one becomes this
 * group's alone — plus any it lists that stopped being sellable, so it can
 * still be let go. Billing refuses to list an unsellable one (`inbound_not_sellable`).
 */
export function inboundChoices(view: PanelInbounds, groupId: string, lang: string): InboundChoice[] {
  return view.inbounds
    .filter((i) => sellable(i) || listsIt(i, groupId))
    .map((i) => ({
      inbound: i,
      sharedWith: formatList(i.listedTo.filter((g) => g.id !== groupId).map((g) => g.name), lang),
      everyGroup: i.audience === "every_group",
      takesNobody: !i.sold || !i.enabled || !sellable(i),
    }));
}

/**
 * The membership places nobody on this panel: nothing it sells is live — its
 * listings **plus** the panel's every-group inbounds (network rule 3a, F-027-ep).
 */
export function sellsNobody(view: PanelInbounds, member: PanelGroupMember): boolean {
  const own = new Set(member.inbounds);
  const sells = (i: PanelInbound) => own.has(i.remoteId) || i.audience === "every_group";
  return !view.inbounds.some((i) => sells(i) && i.sold && i.enabled && sellable(i));
}
