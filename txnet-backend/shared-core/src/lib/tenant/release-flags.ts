import { ReleaseFlagStage, type Prisma } from '@prisma/client';
import { z } from 'zod';

import { UnscopedRedisKeys } from '../redis/keys';
import { platformTenantIdOf } from './platform-tenant';

/**
 * The release flags in play (OPS-1-ag, ADR-0164 point 4) — declared once (C-09).
 *
 * A risky feature adds its key here in its own row and ships with it `off`;
 * the platform switches it on for its own tenant, then for resellers, and off
 * again, from the panel (`tenant/contract.release-flags.md`) — no deploy.
 * Once a flag is on for everyone and staying, the feature's next row removes
 * the key and its checks: a flag is a way to release, not a setting.
 */
export const RELEASE_FLAGS = [] as const satisfies readonly string[];

/** A key of {@link RELEASE_FLAGS}; asking about any other does not compile. */
export type ReleaseFlagKey = (typeof RELEASE_FLAGS)[number];

/** A cached copy outlives a lost delete by at most this long; every write deletes it (twice). */
export const RELEASE_FLAG_CACHE_TTL_S = 300;

const stateSchema = z.object({
  stage: z.nativeEnum(ReleaseFlagStage),
  platformTenantId: z.string(),
  on: z.array(z.string()),
  off: z.array(z.string()),
});

/** One flag whole, as cached: its stage, the tenant `platform` means, and the resellers with an exception. */
export type ReleaseFlagState = z.infer<typeof stateSchema>;

/** Does `tenantId` have the flag? Its own exception first, then the stage. */
export function releaseFlagIsOn(state: ReleaseFlagState, tenantId: string): boolean {
  if (state.on.includes(tenantId)) return true;
  if (state.off.includes(tenantId)) return false;
  switch (state.stage) {
    case ReleaseFlagStage.everyone:
      return true;
    case ReleaseFlagStage.platform:
      return tenantId === state.platformTenantId;
    case ReleaseFlagStage.off:
      return false;
  }
}

/** The reads a flag's state needs, on the cross-tenant client: exceptions are every reseller's rows. */
export type ReleaseFlagReader = Pick<Prisma.TransactionClient, 'releaseFlag' | 'releaseFlagException' | 'tenant'>;

/** One flag's state from the database. A flag with no row is `off`. */
export async function readReleaseFlag(db: ReleaseFlagReader, key: string): Promise<ReleaseFlagState> {
  const [flag, exceptions, platformTenantId] = await Promise.all([
    db.releaseFlag.findUnique({ where: { key }, select: { stage: true } }),
    // Bounded by the number of resellers: one row per reseller at most (PK tenantId, key).
    db.releaseFlagException.findMany({ where: { key }, select: { tenantId: true, isOn: true } }),
    platformTenantIdOf(db),
  ]);
  return {
    stage: flag?.stage ?? ReleaseFlagStage.off,
    platformTenantId,
    on: exceptions.filter((e) => e.isOn).map((e) => e.tenantId),
    off: exceptions.filter((e) => !e.isOn).map((e) => e.tenantId),
  };
}

/** The Redis calls the cache makes (a service's `RedisService`). */
export interface ReleaseFlagCache {
  get(key: string): Promise<string | null>;
  setWithTtl(key: string, value: string, ttlSec: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * Whether a tenant has a release flag, for any service: one Redis read, the
 * database on a miss. A switch takes effect on the next request because the
 * write that makes it deletes the cached copy ({@link forget}).
 */
export class ReleaseFlags {
  constructor(
    private readonly db: ReleaseFlagReader,
    private readonly cache: ReleaseFlagCache,
  ) {}

  async isOn(key: ReleaseFlagKey, tenantId: string): Promise<boolean> {
    return releaseFlagIsOn(await this.state(key), tenantId);
  }

  async state(key: string): Promise<ReleaseFlagState> {
    const cacheKey = UnscopedRedisKeys.releaseFlag(key);
    const cached = await this.cache.get(cacheKey);
    const parsed = cached === null ? null : stateSchema.safeParse(JSON.parse(cached));
    if (parsed?.success) return parsed.data;
    const state = await readReleaseFlag(this.db, key);
    await this.cache.setWithTtl(cacheKey, JSON.stringify(state), RELEASE_FLAG_CACHE_TTL_S);
    return state;
  }

  /**
   * Drop the cached copy of `key`. A write calls it inside its transaction, so
   * a Redis it cannot reach refuses the switch rather than leaving it unseen,
   * and again after the commit, so a read that cached the old state between
   * the two is dropped too.
   */
  forget(key: string): Promise<unknown> {
    return this.cache.del(UnscopedRedisKeys.releaseFlag(key));
  }
}
