import { Prisma } from '@prisma/client';

import { LayerValues, Resolved, resolveLayers } from './layered-setting';

/**
 * Whether a user may move their own config to another server, and how long
 * they wait between two moves (F-410-a, D-63: free, at once, no approval; the
 * reseller may change the wait or switch it off). Resolved product override
 * -> tenant -> platform, as the selling settings resolve (F-027-cg).
 */
export type SelfMoveValues = { enabled: boolean; cooldownHours: number };

export type SelfMoveLayer = 'product' | 'tenant' | 'platform';

/** One layer's own values, as stored: null = not set here. */
export type SelfMoveOwn = { enabled: boolean | null; cooldownHours: number | null };

export type EffectiveSelfMove = Resolved<SelfMoveValues, SelfMoveLayer>;

/** D-63's recommendation, which the user took: on, one move a day. */
export const PLATFORM_SELF_MOVE_DEFAULTS: Readonly<SelfMoveValues> = Object.freeze({ enabled: true, cooldownHours: 24 });

/** The longest wait a tenant may set: a year. Past it is a typo, not a policy (CHECK in the migration). */
export const MAX_SELF_MOVE_COOLDOWN_HOURS = 8760;

/** Each value in effect and the layer it came from. `product` is null for a Grant of no product, or one with no override. */
export function effectiveSelfMove(product: LayerValues<SelfMoveValues> | null, tenant: LayerValues<SelfMoveValues> | null): EffectiveSelfMove {
  return resolveLayers(
    [
      ['product', product],
      ['tenant', tenant],
    ],
    PLATFORM_SELF_MOVE_DEFAULTS,
    'platform',
  );
}

const OWN_COLUMNS = { enabled: true, cooldownHours: true } as const;

/** A tenant's own layer, as stored; every value null when it set nothing. */
export async function tenantSelfMoveOf(tx: Prisma.TransactionClient, tenantId: string): Promise<SelfMoveOwn> {
  const row = await tx.configSelfMoveSetting.findUnique({ where: { tenantId }, select: OWN_COLUMNS });
  return row ?? { enabled: null, cooldownHours: null };
}

/** A product's override in a tenant, as stored; every value null when there is none. */
export async function productSelfMoveOf(tx: Prisma.TransactionClient, tenantId: string, productId: string): Promise<SelfMoveOwn> {
  const row = await tx.configSelfMoveProductSetting.findUnique({ where: { tenantId_productId: { tenantId, productId } }, select: OWN_COLUMNS });
  return row ?? { enabled: null, cooldownHours: null };
}

/** Nothing set at the layer: the row is deleted, not kept empty. */
export const setsNothing = (own: SelfMoveOwn): boolean => own.enabled === null && own.cooldownHours === null;

/** The same values at a layer: writing them changes nothing, so nothing is written or audited. */
export const sameOwn =(a: SelfMoveOwn, b: SelfMoveOwn): boolean => a.enabled === b.enabled && a.cooldownHours === b.cooldownHours;
