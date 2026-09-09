import { Injectable, Logger } from '@nestjs/common';
import { RedisKeys, RedisTtl } from '../redis/redis.keys';
import { RedisService } from '../redis/redis.service';
import { normalizeHost } from './tenant';

/** A tenant reduced to what resolution answers with — see {@link ResolvedTenant}. */
export type CachedTenant = { id: string; slug: string };

/**
 * The marker for "this was looked up and there is nothing", stored so a
 * stranger's host costs one Redis read rather than one database read. It has
 * to be a value Redis can hold and JSON cannot produce, because a missing key
 * and a cached `null` mean opposite things: *not looked up yet* and *looked up,
 * answers nothing*. Collapsing them would send every unknown host to Postgres.
 */
const MISS = '-';

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
    lookup: () => Promise<CachedTenant | null>,
  ): Promise<CachedTenant | null> {
    return this.through(RedisKeys.tenantByHost(host), lookup);
  }

  /** The tenant this claimed id proves to, looked up at most once per TTL. */
  byId(
    tenantId: string,
    lookup: () => Promise<CachedTenant | null>,
  ): Promise<CachedTenant | null> {
    return this.through(RedisKeys.tenantById(tenantId), lookup);
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
   * own claim without waiting out the backstop.
   */
  async invalidateTenant(tenantId: string): Promise<void> {
    await this.redis.del(RedisKeys.tenantById(tenantId));
  }

  private async through(
    key: string,
    lookup: () => Promise<CachedTenant | null>,
  ): Promise<CachedTenant | null> {
    const hit = await this.read(key);
    if (hit !== undefined) return hit;

    const value = await lookup();
    await this.write(key, value);
    return value;
  }

  /** `undefined` means nothing is cached; `null` means a cached "no tenant". */
  private async read(key: string): Promise<CachedTenant | null | undefined> {
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

    try {
      return JSON.parse(raw) as CachedTenant;
    } catch {
      // A value this service did not write, or one left by an older shape.
      // Treating it as absent re-reads the row and overwrites it, which is
      // cheaper and safer than resolving a request from something unparseable.
      return undefined;
    }
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
