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
 * The two settings `mirror` reads. `priority` / `weight` are not asked — no
 * fulfilled strategy reads them (panel-web rule 11). Empty = inherit (null):
 * a member cannot set "no cap" under a capped panel (network rule 4a).
 */
export type MemberForm = { placement: InboundPlacement | ""; maxClients: string };

export function memberFormOf(member: PanelGroupMember): MemberForm {
  return { placement: member.inboundPlacement ?? "", maxClients: member.maxClients === null ? "" : String(member.maxClients) };
}

export type MemberValidation = { ok: true; body: MemberSellingBody } | { ok: false; errors: Partial<Record<keyof MemberForm | "form", string>> };

/** billing's member `PATCH` over what changed: an untouched setting is never re-sent, and an edit changing nothing is refused here. */
export function validateMember(form: MemberForm, member: PanelGroupMember): MemberValidation {
  const body: MemberSellingBody = {};
  const placement = form.placement === "" ? null : form.placement;
  if (placement !== member.inboundPlacement) body.inboundPlacement = placement;

  const text = form.maxClients.trim();
  const n = Number(text);
  if (text !== "" && !(Number.isInteger(n) && n >= 1 && n <= MAX_CAP)) return { ok: false, errors: { maxClients: K.inbounds.invalid.cap } };
  const cap = text === "" ? null : n;
  if (cap !== member.maxClients) body.maxClients = cap;

  if (Object.keys(body).length === 0) return { ok: false, errors: { form: K.inbounds.invalid.unchanged } };
  return { ok: true, body };
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

export type MemberInboundsValidation = { ok: true; inbounds: string[] } | { ok: false; error: string };

const byRemoteId = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** The `PUT` is the whole set; `[]` is the pool again, always allowed. One equal to what the member holds is refused here. */
export function validateMemberInbounds(picked: readonly string[], member: PanelGroupMember): MemberInboundsValidation {
  const next = [...new Set(picked)].sort(byRemoteId);
  const held = [...member.inbounds].sort(byRemoteId);
  if (next.length === held.length && next.every((id, i) => id === held[i])) return { ok: false, error: K.inbounds.invalid.unchanged };
  return { ok: true, inbounds: next };
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
