import { Injectable, Logger } from '@nestjs/common';
import {
  HOST_SURFACE_MISS,
  type HostSurface,
  RedisTtl,
  UnscopedRedisKeys,
  isHostSurface,
  surfaceOfHost,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * Which tenant a public request's Host belongs to, read through
 * `tenant:host:<host>` (F-018-al).
 *
 * **Why a cache was needed at all.** Every route under `public/tenant/` —
 * `files/<key>`, `branding`, `domain-probe`, `serves-panel` — is
 * unauthenticated, and each one read one `tenant_domain` row per request.
 * `files` is the load: one query per image per visitor. Measured 2026-09-20 on
 * the dev database, that lookup is **~0.63 ms of server-side work**, against a
 * **0.071 ms p50 Redis GET** over the same container network — so the point is
 * less the millisecond than which machine pays it. Postgres is the shared
 * resource a reseller's landing page must not be able to spend.
 *
 * **It is `auth-service`'s key, deliberately** (ADR-0025). That service caches
 * the same question for every signed-in request, and `tenant-service` already
 * deletes this key when a domain is created, verified, switched or removed
 * (`tenant-domain.service.ts`). A second key under a second name would be a
 * second thing to delete at each of those sites, and the one missed outlives a
 * change of owner — a request served as the host's previous tenant, which is a
 * cross-tenant leak rather than a stale page. The shape, its validator and the
 * miss marker therefore live in `shared-core`'s `host-surface.ts`, imported by
 * both; the TTL here is only a backstop against a writer that forgot to
 * invalidate, never what makes a newly verified domain start working.
 *
 * **Reads fail open, writes fail quiet.** A Redis outage must not turn every
 * public request into the neutral 404 an unresolved host gets — the database
 * still knows the answer — so a read that throws is logged and treated as a
 * miss. This service never invalidates: that is
 * `TenantDomainService`'s, and it fails loud there for the opposite reason.
 */
@Injectable()
export class HostSurfaceCache {
  private readonly logger = new Logger(HostSurfaceCache.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: CrossTenantPrismaService,
  ) {}

  /**
   * The surface this normalized host proves, looked up at most once per TTL.
   * A host with no row is cached as a miss, so a flood aimed at a name nobody
   * owns costs one Redis read rather than one query.
   */
  async of(host: string | null): Promise<HostSurface | null> {
    // No usable host is not a lookup: the empty string must never be a key that
    // could match a row.
    if (!host) return null;

    const key = UnscopedRedisKeys.tenantByHost(host);
    const hit = await this.read(key);
    if (hit !== undefined) return hit;

    const surface = await surfaceOfHost(this.prisma, host);
    await this.write(key, surface);
    return surface;
  }

  /** `undefined` means nothing usable is cached; `null` means a cached "no tenant". */
  private async read(key: string): Promise<HostSurface | null | undefined> {
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch (err) {
      this.logger.warn(
        `host surface read failed for '${key}', falling back to the database: ${(err as Error).message}`,
      );
      return undefined;
    }

    if (raw === null) return undefined;
    if (raw === HOST_SURFACE_MISS) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A value this shape did not write. Treating it as absent re-reads the
      // row and overwrites it, which is cheaper and safer than resolving a
      // public request from something unparseable.
      return undefined;
    }
    // Checked, not asserted — see `isHostSurface`: this is what drains an
    // older shape within one lookup per host instead of a keyspace bump.
    return isHostSurface(parsed) ? parsed : undefined;
  }

  private async write(key: string, surface: HostSurface | null): Promise<void> {
    try {
      await this.redis.setWithTtl(
        key,
        surface === null ? HOST_SURFACE_MISS : JSON.stringify(surface),
        surface === null ? RedisTtl.tenantResolutionMiss : RedisTtl.tenantResolution,
      );
    } catch (err) {
      // A cache that cannot be written is a slow resolver, not a wrong one.
      this.logger.warn(`host surface write failed for '${key}': ${(err as Error).message}`);
    }
  }
}
