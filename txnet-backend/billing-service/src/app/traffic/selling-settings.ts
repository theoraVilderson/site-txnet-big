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
 * {@link sellingInbounds} (F-027-ch).
 */
export type SellingValues = {
  inboundPlacement: InboundPlacement;
  /** The most users on the panel before it takes no new one; null = no cap. */
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

export const SELLING_SETTINGS = ['inboundPlacement', 'maxClients', 'priority', 'weight', 'inboundsPerBuyer'] as const satisfies readonly SellingSetting[];

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

/** The values alone, as fulfilment places by them. */
export function sellingValues(effective: EffectiveSellingSettings): SellingValues {
  return {
    inboundPlacement: effective.inboundPlacement.value,
    maxClients: effective.maxClients.value,
    priority: effective.priority.value,
    weight: effective.weight.value,
    inboundsPerBuyer: effective.inboundsPerBuyer.value,
  };
}

/** An inbound a buyer may be placed on: of a protocol we sell, with its cap (null = none). */
export type SellingInbound = { remoteId: string; protocol: ConfigProtocol; maxClients: number | null };

type AssignedInbound = { remoteId: string; protocol: ConfigProtocol | null; maxClients: number | null; enabled: boolean; goneAt: Date | null };

/**
 * Which inbounds one group sells on one panel (F-027-ch, ADR-0090 decision 3):
 * the membership's own assignments when it has any, else the panel's default
 * pool — `sold` inbounds no membership holds, as the caller loaded them.
 * An assignment **replaces** the pool: a member whose every assigned inbound is
 * disabled or gone sells nothing, never the pool, so an admin's split between
 * groups is not undone by an inbound going down.
 */
export function sellingInbounds(member: {
  inbounds: { inbound: AssignedInbound }[];
  panel: { inbounds: { remoteId: string; protocol: ConfigProtocol | null; maxClients: number | null }[] };
}): SellingInbound[] {
  const own = member.inbounds.length > 0;
  const rows = own ? member.inbounds.map((a) => a.inbound).filter((i) => i.enabled && i.goneAt === null) : member.panel.inbounds;
  return rows.flatMap((i) => (i.protocol === null ? [] : [{ remoteId: i.remoteId, protocol: i.protocol, maxClients: i.maxClients }]));
}
