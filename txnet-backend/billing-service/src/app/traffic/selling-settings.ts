import { ConfigProtocol, InboundPlacement } from '@prisma/client';

/**
 * A panel's selling settings, resolved in three layers (F-027-cg, ADR-0090
 * decision 2): the group membership, then the panel, then the platform
 * default. A null at a layer is "not set here" and is passed over; the
 * platform layer always answers, so every setting resolves.
 *
 * Only *selling* choices resolve this way. Server facts — addresses,
 * credentials, `maxRequestsPerMinute`, `maxLineRateBps` — are the panel's and
 * no group overrides them. Which inbounds a member sells is
 * {@link sellingInbounds} (F-027-ep).
 */
export type SellingValues = {
  inboundPlacement: InboundPlacement;
  /**
   * The most users before the panel takes no new one; null = no cap. At the
   * panel's layer a physical cap over every Grant; at a member's, the group's
   * share, over its own Grants only (F-027-eq, ADR-0127 decision 3).
   */
  maxClients: number | null;
  /** Lower first; read by strategies that choose among members, not `mirror`. */
  priority: number;
  weight: number;
  /** How many inbounds `hrw` places a buyer on (F-027-di); read by no other placement. */
  inboundsPerBuyer: number;
};

export type SellingSetting = keyof SellingValues;
export type SellingLayer = 'member' | 'panel' | 'platform';

/** One layer's own values: null (or absent) = not set at this layer. */
export type SellingLayerValues = { [K in SellingSetting]?: SellingValues[K] | null };

export type EffectiveSellingSettings = { [K in SellingSetting]: { value: SellingValues[K]; layer: SellingLayer } };

/**
 * What a panel sells by when neither it nor the membership says otherwise.
 * `network.panel`'s columns had these as defaults before F-027-cg; the
 * fulfilment scan's SQL reads the three it needs through `COALESCE`.
 */
export const PLATFORM_SELLING_DEFAULTS: Readonly<SellingValues> = Object.freeze({
  inboundPlacement: InboundPlacement.all,
  maxClients: null,
  priority: 0,
  weight: 1,
  // Two survive one inbound lost with no move at all (SPEC weakness #25).
  inboundsPerBuyer: 2,
});

/** Each setting's effective value and the layer it came from. `member` is null for the panel's own view. */
export function effectiveSellingSettings(member: SellingLayerValues | null, panel: SellingLayerValues): EffectiveSellingSettings {
  const pick = <K extends SellingSetting>(key: K): { value: SellingValues[K]; layer: SellingLayer } => {
    const own = member?.[key];
    if (own !== null && own !== undefined) return { value: own as SellingValues[K], layer: 'member' };
    const panels = panel[key];
    if (panels !== null && panels !== undefined) return { value: panels as SellingValues[K], layer: 'panel' };
    return { value: PLATFORM_SELLING_DEFAULTS[key], layer: 'platform' };
  };
  return {
    inboundPlacement: pick('inboundPlacement'),
    maxClients: pick('maxClients'),
    priority: pick('priority'),
    weight: pick('weight'),
    inboundsPerBuyer: pick('inboundsPerBuyer'),
  };
}

/** A panel's inbound ids in the panel's own order: `2` before `10`. */
export const byRemoteId = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/**
 * An inbound a buyer may be placed on: of a protocol we sell, with its
 * physical cap over every Grant and the group's share of it, over the group's
 * own (F-027-eq); null = none. An `every_group` inbound has no share.
 */
export type SellingInbound = { remoteId: string; protocol: ConfigProtocol; maxClients: number | null; share: number | null };

type ListedInbound = { remoteId: string; protocol: ConfigProtocol | null; maxClients: number | null; enabled: boolean; goneAt: Date | null };

/**
 * Which inbounds one group sells on one panel (F-027-ep, ADR-0127 decision 1):
 * the membership's own listings — enabled, not gone, of a protocol we sell —
 * **plus** the panel's `every_group` inbounds, as the caller loaded them
 * (`sold`, placeable). A listing on a disabled inbound sells nothing and never
 * falls back to anything else. The two never name one inbound (a trigger
 * keeps them apart); should they, the listing is kept and the inbound is
 * named once. An inbound a running job is releasing the group from
 * (`releases`, F-027-es) is sold to nobody new; a caller that loads none
 * (catalog's protocols) still names it.
 */
export function sellingInbounds(member: {
  inbounds: { maxClients?: number | null; inbound: ListedInbound }[];
  releases?: { inboundRemoteId: string }[];
  panel: { inbounds: { remoteId: string; protocol: ConfigProtocol | null; maxClients: number | null }[] };
}): SellingInbound[] {
  const releasing = new Set((member.releases ?? []).map((r) => r.inboundRemoteId));
  const listed = member.inbounds.filter((l) => l.inbound.enabled && l.inbound.goneAt === null).map((l) => ({ ...l.inbound, share: l.maxClients ?? null }));
  const names = new Set(listed.map((i) => i.remoteId));
  const rows = [...listed, ...member.panel.inbounds.filter((i) => !names.has(i.remoteId)).map((i) => ({ ...i, share: null }))];
  return rows.flatMap((i) => (i.protocol === null || releasing.has(i.remoteId) ? [] : [{ remoteId: i.remoteId, protocol: i.protocol, maxClients: i.maxClients, share: i.share }]));
}
