import { Injectable, Logger } from '@nestjs/common';
import {
  type CachedTenantRow,
  HOST_SURFACE_MISS,
  type HostSurface,
  isCachedTenantRow,
  isHostSurface,
} from '@txnet-backend/shared-core';

import { RedisKeys, RedisTtl } from '../redis/redis.keys';
import { RedisService } from '../redis/redis.service';
import { normalizeHost } from './tenant';

/**
 * The shape stored under `tenant:host:<host>` and `tenant:id:<id>`, **defined
 * in `shared-core`** (`tenant/host-surface.ts`, F-018-al) because
 * `tenant-service` writes the host entry too: its public routes read the same
 * question, and a second key under a second name is a second thing to delete
 * at every domain write — the one missed outliving a change of owner is the
 * cross-tenant leak this service exists to prevent.
 *
 * The names stay as this service's call sites already read them.
 */
export type CachedTenant = CachedTenantRow;
export type CachedSurface = HostSurface;

/** @see HOST_SURFACE_MISS — the marker both services must spell alike. */
const MISS = HOST_SURFACE_MISS;

/**
 * The `host -> tenant` cache, invalidated explicitly rather than by TTL
 * (ADR-0025 decision 4, catalog F-1211).
 *
 * **Why this is not a `Map`.** The thing being cached is which tenant owns an
 * address, and the four writes that change that answer — creating a domain,
 * verifying one, switching a standby over, deleting one — happen in one
 * process while every other replica keeps serving requests. An in-process
 * cache cannot be told about them, so its only correctness argument is that it
 * expires soon enough; and for the window in between, a request arrives on a
 * host that now belongs to someone else and is served as its previous owner.
 * That is a cross-tenant leak, not a stale page, which is why the catalog
 * names the invalidation rather than a shorter TTL. Redis is shared, so one
 * `DEL` reaches every replica.
 *
 * The TTL that remains is a **backstop**: it bounds the damage from a writer
 * that forgets to invalidate, and it is not what makes a newly verified domain
 * start working.
 *
 * **Reads fail open, writes fail loud.** A Redis outage must not turn every
 * request into the neutral 404 that an unresolved host gets — the database
 * still knows the answer — so a read that throws is logged and treated as a
 * miss. Invalidation is the opposite: an `invalidate*` that cannot reach Redis
 * throws, so the caller can refuse the domain change rather than complete it
 * on top of a mapping it failed to retract.
 */
@Injectable()
export class TenantCacheService {
  private readonly logger = new Logger(TenantCacheService.name);

  constructor(private readonly redis: RedisService) {}

  /** The tenant this normalized host maps to, looked up at most once per TTL. */
  byHost(
    host: string,
    lookup: () => Promise<CachedSurface | null>,
  ): Promise<CachedSurface | null> {
    return this.through(RedisKeys.tenantByHost(host), lookup, isHostSurface);
  }

  /** The tenant this claimed id proves to, looked up at most once per TTL. */
  byId(
    tenantId: string,
    lookup: () => Promise<CachedTenant | null>,
  ): Promise<CachedTenant | null> {
    return this.through(RedisKeys.tenantById(tenantId), lookup, isCachedTenantRow);
  }

  /**
   * Forget what this domain resolved to. Call it from **every** write that
   * changes which tenant a host belongs to: creation, verification, standby
   * switchover and deletion (ADR-0025). The host is normalized here so a
   * caller holding `tenant_domain.domainValue` as stored, or a host as typed,
   * both reach the same key.
   *
   * Deleting a key that was never cached is not an error and needs no check —
   * that is the state invalidation is trying to reach.
   */
  async invalidateDomain(domainValue: string | null | undefined): Promise<void> {
    const host = normalizeHost(domainValue);
    if (!host) return;
    await this.redis.del(RedisKeys.tenantByHost(host));
  }

  /**
   * Forget what this tenant id proved to. Call it when a tenant stops existing
   * or stops being resolvable, so a token that outlives it stops answering its
   * own claim without waiting out the backstop. A change of owner is not this:
   * it goes through `invalidateTenantOwner` (shared-core), which drops the
   * host entries too.
   */
  async invalidateTenant(tenantId: string): Promise<void> {
    await this.redis.del(RedisKeys.tenantById(tenantId));
  }

  private async through<T extends CachedTenant>(
    key: string,
    lookup: () => Promise<T | null>,
    shape: (value: unknown) => value is T,
  ): Promise<T | null> {
    const hit = await this.read(key, shape);
    if (hit !== undefined) return hit;

    const value = await lookup();
    await this.write(key, value);
    return value;
  }

  /** `undefined` means nothing is cached; `null` means a cached "no tenant". */
  private async read<T extends CachedTenant>(
    key: string,
    shape: (value: unknown) => value is T,
  ): Promise<T | null | undefined> {
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch (err) {
      this.logger.warn(
        `tenant cache read failed for '${key}', falling back to the database: ` +
          `${(err as Error).message}`,
      );
      return undefined;
    }

    if (raw === null) return undefined;
    if (raw === MISS) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A value this service did not write, or one left by an older shape.
      // Treating it as absent re-reads the row and overwrites it, which is
      // cheaper and safer than resolving a request from something unparseable.
      return undefined;
    }

    // The shape is checked, not asserted, and that is what carries the
    // `purpose` column across a deploy (F-066-q): every host entry written
    // before it existed parses fine and lacks the field, and a surface whose
    // purpose is unknown must not be treated as a panel one. Failing the check
    // re-reads the row and overwrites the entry, so the old shape drains
    // itself within one lookup per host instead of needing a keyspace bump.
    return shape(parsed) ? parsed : undefined;
  }

  private async write(key: string, value: CachedTenant | null): Promise<void> {
    try {
      await this.redis.set(
        key,
        value === null ? MISS : JSON.stringify(value),
        value === null ? RedisTtl.tenantResolutionMiss : RedisTtl.tenantResolution,
      );
    } catch (err) {
      // A cache that cannot be written is a slow resolver, not a wrong one.
      this.logger.warn(
        `tenant cache write failed for '${key}': ${(err as Error).message}`,
      );
    }
  }
}
