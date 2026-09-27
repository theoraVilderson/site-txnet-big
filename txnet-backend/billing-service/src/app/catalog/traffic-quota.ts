import { FulfilmentKind, VariantBillingMode } from '@prisma/client';

/**
 * What a variant's quotas say about traffic (F-111-p, the user's call
 * 2026-09-26): a network variant must state it, and `0` means unlimited.
 *
 * Only here does 0 mean unlimited. Everywhere downstream 0 means *empty* —
 * the planner's ceilings, exhaustion, a config's create — so a sold 0 is
 * carried on as an explicit flag (F-111-q), never as the number.
 */
export type TrafficQuota = { kind: 'missing' } | { kind: 'unlimited' } | { kind: 'limited'; bytes: bigint };

export function trafficQuotaOf(quotas: unknown): TrafficQuota {
  const limit = (quotas as { traffic_bytes?: { limit?: unknown } } | null)?.traffic_bytes?.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) return { kind: 'missing' };
  return limit === 0 ? { kind: 'unlimited' } : { kind: 'limited', bytes: BigInt(limit) };
}

/**
 * A prepaid network Grant is a bag filled with the sold limit (ADR-0072), so
 * with no traffic row it is a 0-byte bag: never placed, refunded by the
 * delivery clock an hour later (VI_PI_AN_PRV-30D). A metered one starts empty
 * and buys blocks, so its traffic is not the variant's to state.
 */
export const mustStateTraffic = (kind: FulfilmentKind, mode: VariantBillingMode): boolean =>
  kind === FulfilmentKind.network_access && mode === VariantBillingMode.prepaid;

/**
 * Whether a sale of this variant can be delivered on traffic today: invoice
 * create refuses, and the shop leaves out, what this answers `false` for.
 * Unlimited is sold: its configs are placed with no limit (F-111-r).
 */
export function sellsTrafficToday(v: { fulfilmentKind: FulfilmentKind; billingMode: VariantBillingMode; quotas: unknown }): boolean {
  return !mustStateTraffic(v.fulfilmentKind, v.billingMode) || trafficQuotaOf(v.quotas).kind !== 'missing';
}
