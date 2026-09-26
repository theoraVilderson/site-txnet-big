import type { InboundPlacement, PanelInbound, PanelInbounds, PanelInboundsBody } from "@/lib/billing-api";
import { SYSTEMS_KEYS } from "./systems";

/**
 * A panel's inbounds on the systems page (F-114-b): which ones a buyer is
 * placed on, how, and how many users each inbound and the panel take. The
 * routes and the write are billing's (`contract.systems.md`); what fulfilment
 * does with the pick is network's (`contract.inbounds.md`). Nothing here
 * decides — it mirrors `updatePanelInboundsSchema` and says what the pick does.
 */
const K = SYSTEMS_KEYS.inbounds;

/** `network.InboundPlacement`, in the schema's order (C-09), with its label and what it does. */
export const INBOUND_PLACEMENTS = ["all", "spread"] as const satisfies readonly InboundPlacement[];

export const PLACEMENT_KEYS: Record<InboundPlacement, { label: string; hint: string }> = {
  all: { label: K.placement.all, hint: K.placement.allHint },
  spread: { label: K.placement.spread, hint: K.placement.spreadHint },
};

/** billing's `capSchema`: a whole number from 1, or none. */
const MAX_CAP = 1_000_000;

export type InboundsForm = {
  placement: InboundPlacement;
  /** The panel's cap as typed; empty = none. */
  panelMax: string;
  /** Per inbound, by the panel's id for it. */
  picks: Record<string, { sold: boolean; cap: string }>;
};

const capText = (n: number | null) => (n === null ? "" : String(n));

export function inboundsFormOf(view: PanelInbounds): InboundsForm {
  return {
    // The placement in force: the panel's own, else the platform's (F-027-cg).
    placement: view.effective.inboundPlacement.value,
    panelMax: capText(view.maxClients),
    picks: Object.fromEntries(view.inbounds.map((i) => [i.remoteId, { sold: i.sold, cap: capText(i.maxClients) }])),
  };
}

/** A buyer can be placed on it: still on the panel, and of a protocol we sell. Billing refuses to sell any other. */
export const sellable = (i: PanelInbound): boolean => i.protocol !== null && i.goneAt === null;

/** Why an inbound will not take a buyer even if ticked, or null when it will. */
export function inboundNote(i: PanelInbound): string | null {
  if (i.goneAt !== null) return K.gone;
  if (i.protocol === null) return K.unknownProtocol;
  if (!i.enabled) return K.disabled;
  return null;
}

/** Fulfilment places nobody here: no ticked inbound a buyer can be placed on (network `contract.inbounds.md` rule 3). */
export function nothingPicked(view: PanelInbounds): boolean {
  return !view.inbounds.some((i) => i.sold && sellable(i) && i.enabled);
}

/** A cap as typed: `null` = none, `undefined` = not a cap. */
function capOf(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= MAX_CAP ? n : undefined;
}

export type InboundsValidation =
  | { ok: true; body: PanelInboundsBody }
  | { ok: false; errors: Record<string, string> };

/** The key an inbound's cap error is filed under. */
export const capField = (remoteId: string) => `cap:${remoteId}`;

/**
 * `updatePanelInboundsSchema` over what changed: only a field or an inbound
 * that differs from the last read is sent, so a pick made elsewhere meanwhile
 * is not overwritten with a stale one, and an edit that changes nothing is
 * refused here rather than as a 400. Ticking an unsellable inbound is never
 * offered, so it is never sent.
 */
export function validateInbounds(form: InboundsForm, view: PanelInbounds): InboundsValidation {
  const errors: Record<string, string> = {};
  const body: PanelInboundsBody = {};

  if (form.placement !== view.effective.inboundPlacement.value) body.inboundPlacement = form.placement;

  const panelMax = capOf(form.panelMax);
  if (panelMax === undefined) errors.panelMax = K.invalid.cap;
  else if (panelMax !== view.maxClients) body.maxClients = panelMax;

  const inbounds: NonNullable<PanelInboundsBody["inbounds"]> = [];
  for (const i of view.inbounds) {
    const pick = form.picks[i.remoteId];
    if (!pick) continue;
    const cap = capOf(pick.cap);
    if (cap === undefined) {
      errors[capField(i.remoteId)] = K.invalid.cap;
      continue;
    }
    const sold = pick.sold && (sellable(i) || i.sold);
    if (sold === i.sold && cap === i.maxClients) continue;
    inbounds.push(cap === i.maxClients ? { remoteId: i.remoteId, sold } : { remoteId: i.remoteId, sold, maxClients: cap });
  }
  if (inbounds.length > 0) body.inbounds = inbounds;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (Object.keys(body).length === 0) return { ok: false, errors: { form: K.invalid.unchanged } };
  return { ok: true, body };
}
