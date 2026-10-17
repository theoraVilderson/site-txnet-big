import { ConfigProtocol, ConfigStatus, DesiredRemote, EnforcementState, GrantStatus, InboundPlacement, PanelGroupMemberRole, PanelGroupStrategy, PanelReviewState, PanelState } from '@prisma/client';

import { InboundPlacementTarget } from './config-actions';
import { hrwPick } from './hrw';
import { PlaceablePanel, placeableMember, servingPanel } from './panel-placeable';
import { byRemoteId, effectiveSellingSettings } from './selling-settings';

/**
 * `mirror`'s plan for one Grant, from facts already loaded (network
 * `contract.groups.md` rule 7, `contract.inbounds.md`): pure, so
 * `GroupFulfilmentService` reads and writes around it and the spec pins it
 * without a database.
 */

/**
 * A picked inbound as fulfilment reads it: `sold`, enabled, not gone, of a
 * known protocol (F-114-b). Two caps, both must have room (F-027-eq, ADR-0127
 * decision 3): `maxClients` over every config on it, `share` — the group's
 * listing's own — over this group's Grants' configs only.
 */
export type InboundFacts = { remoteId: string; protocol: ConfigProtocol; maxClients: number | null; share: number | null; clients: number; groupClients: number };

/**
 * `inboundPlacement` and `inboundsPerBuyer` are the effective ones for this
 * group: member -> panel -> platform (F-027-cg). The cap is two (F-027-eq):
 * `maxClients`, the panel's layer, physical over every Grant on it, and
 * `groupMaxClients`, the member's own, over this group's Grants alone.
 */
type PanelFacts = {
  reviewState: PanelReviewState;
  panelState: PanelState;
  driftEvents: PlaceablePanel['driftEvents'];
  inboundPlacement: InboundPlacement;
  maxClients: number | null;
  groupMaxClients: number | null;
  /** K under `hrw` (F-027-di). */
  inboundsPerBuyer: number;
  /** Grants holding a live config on the panel — what `maxClients` caps. */
  users: number;
  /** This group's Grants among them — what `groupMaxClients` caps. */
  groupUsers: number;
  inbounds: InboundFacts[];
};

export type MemberFacts = { panelId: string; role: PanelGroupMemberRole; panel: PanelFacts };

type SellingLayer = { inboundPlacement?: InboundPlacement | null; maxClients?: number | null; inboundsPerBuyer?: number | null };

/**
 * How this group places on a member's panel: the member's own value, else the
 * panel's, else the platform default (F-027-cg, ADR-0090 decision 2) — except
 * the cap, whose two layers both hold (F-027-eq): the panel's (else the
 * platform's, none) over every Grant, the member's over its group's. The
 * due-scan SQL in `fulfilDue` resolves the same with `COALESCE`, and assumes
 * the platform cap is none.
 */
export function placementSettings(m: SellingLayer & { panel: SellingLayer }): Pick<PanelFacts, 'inboundPlacement' | 'maxClients' | 'groupMaxClients' | 'inboundsPerBuyer'> {
  const effective = effectiveSellingSettings(m, m.panel);
  return {
    inboundPlacement: effective.inboundPlacement.value,
    maxClients: effectiveSellingSettings(null, m.panel).maxClients.value,
    groupMaxClients: m.maxClients ?? null,
    inboundsPerBuyer: effective.inboundsPerBuyer.value,
  };
}

type ConfigFacts = {
  panelId: string;
  inboundRemoteId: string | null;
  status: ConfigStatus;
  desiredRemote: DesiredRemote;
  enforcementState: EnforcementState;
  credentialGroupId: string | null;
  drainedAt: Date | null;
};

export type FulfilmentFacts = {
  /** The key `hrw` ranks a member's inbounds by (F-027-di). */
  grantId: string;
  grantStatus: GrantStatus;
  group: { strategy: PanelGroupStrategy; minHealthyPanels: number; members: MemberFacts[] };
  configs: ConfigFacts[];
};

export type FulfilmentPlan = {
  /** Configs to place now, in panel-id then inbound order. */
  place: InboundPlacementTarget[];
  /**
   * Non-drain members owed a config that cannot take one yet — not placeable,
   * nothing picked (`no_inbound`), or full — retried when they can.
   */
  waiting: string[];
  /** A `pending` Grant has `minHealthyPanels` serving panels with a confirmed config. */
  activate: boolean;
  /** The group's id if one of the Grant's configs already carries it; null means a new one. */
  credentialGroupId: string | null;
};

const byInbound = (a: { remoteId: string }, b: { remoteId: string }) => byRemoteId(a.remoteId, b.remoteId);
const under = (cap: number | null, count: number) => cap === null || count < cap;
/** Every cap on the inbound has a seat: its own over every config, the group's share over the group's (F-027-eq). */
const hasRoom = (i: InboundFacts) => under(i.maxClients, i.clients) && under(i.share, i.groupClients);
/** The panel takes no new user at either cap: its own over every Grant, the member's over the group's (F-027-eq). */
const panelFull = (p: PanelFacts) => !under(p.maxClients, p.users) || !under(p.groupMaxClients, p.groupUsers);

/**
 * The inbounds one member owes this Grant now (network `contract.inbounds.md`).
 * `held`: the inbounds its un-drained configs on the panel are on — `null` for
 * a row placed before F-114-b, which holds the whole panel.
 */
function placementsOn(grantId: string, m: MemberFacts, held: (string | null)[], live: boolean): { targets: InboundFacts[]; owed: boolean } {
  if (held.includes(null)) return { targets: [], owed: false };
  const picked = [...m.panel.inbounds].sort(byInbound);
  if (m.panel.inboundPlacement === InboundPlacement.hrw) {
    // K of the picks by the Grant's rank (F-027-di). Every un-drained config
    // counts towards K wherever it is, so an inbound lost or unticked moves
    // nobody (rule 6); its buyer is re-placed once that config is drained.
    const missing = picked.filter((i) => !held.includes(i.remoteId));
    if (held.length >= m.panel.inboundsPerBuyer || (missing.length === 0 && held.length > 0)) return { targets: [], owed: false };
    const full = !live && panelFull(m.panel);
    // A config added is a new seat on its inbound, so a full one is passed over even for a buyer already placed.
    const ranked = hrwPick(grantId, missing.map((i) => ({ id: i.remoteId, weight: 1, healthy: true, full: !hasRoom(i) })), m.panel.inboundsPerBuyer - held.length, true);
    return { targets: full ? [] : missing.filter((i) => ranked.includes(i.remoteId)), owed: true };
  }
  if (m.panel.inboundPlacement === InboundPlacement.spread) {
    if (held.length > 0) return { targets: [], owed: false };
    const open = picked.filter(hasRoom).sort((a, b) => a.clients - b.clients || byInbound(a, b));
    const full = !live && panelFull(m.panel);
    return { targets: full ? [] : open.slice(0, 1), owed: true };
  }
  const missing = picked.filter((i) => !held.includes(i.remoteId));
  // Owed nothing once on every pick; a panel with nothing picked still owes a user it does not hold (`no_inbound`).
  if (missing.length === 0 && held.length > 0) return { targets: [], owed: false };
  // A panel at its cap takes no new user; a user already on it still gets the inbounds it lacks.
  const full = !live && panelFull(m.panel);
  return { targets: full ? [] : missing.filter(hasRoom), owed: true };
}

/**
 * `mirror` over what is true now (network `contract.groups.md` rule 7,
 * `contract.inbounds.md`). Pure, so the same facts give the same plan in any
 * member order.
 *
 * **An inbound with any config of this Grant is covered**, whatever its
 * status: a row still `pending` on a panel that died mid-provisioning is
 * carried by the convergence pass when it returns, and a retired one was a
 * decision (a delete, or a move away) that a refill would undo. Under
 * `spread`, any config covers the whole panel. The partial unique index
 * `config_group_panel_once` (grant, panel, inbound) holds the same line against
 * two concurrent runs. **Except a drained one** (`drainedAt`, F-027-bp): the
 * platform emptied the panel, the user decided nothing, so a member re-added
 * is placed again.
 */
export function planFulfilment(facts: FulfilmentFacts): FulfilmentPlan {
  const kept = facts.configs.filter((c) => !c.drainedAt);
  const members = [...facts.group.members].sort((a, b) => a.panelId.localeCompare(b.panelId));

  const place: InboundPlacementTarget[] = [];
  const waiting: string[] = [];
  for (const m of members) {
    if (m.role === PanelGroupMemberRole.drain) continue;
    const mine = kept.filter((c) => c.panelId === m.panelId);
    const live = mine.some((c) => c.desiredRemote === DesiredRemote.present);
    const { targets, owed } = placementsOn(facts.grantId, m, mine.map((c) => c.inboundRemoteId), live);
    if (!owed) continue;
    if (!placeableMember(m) || targets.length === 0) {
      waiting.push(m.panelId);
      continue;
    }
    for (const i of targets) place.push({ panelId: m.panelId, inboundRemoteId: i.remoteId, protocol: i.protocol });
  }

  const serving = new Set(members.filter((m) => servingPanel(m.panel)).map((m) => m.panelId));
  const confirmed = new Set(
    facts.configs
      .filter(
        (c) =>
          c.status === ConfigStatus.active &&
          c.desiredRemote === DesiredRemote.present &&
          c.enforcementState === EnforcementState.complete &&
          serving.has(c.panelId),
      )
      .map((c) => c.panelId),
  ).size;

  return {
    place,
    waiting,
    activate: facts.grantStatus === GrantStatus.pending && confirmed >= facts.group.minHealthyPanels,
    credentialGroupId: facts.configs.find((c) => c.credentialGroupId !== null)?.credentialGroupId ?? null,
  };
}

