import type {
  TenantDomainPurpose,
  TenantDomainType,
  TenantType,
} from '@prisma/client';

/**
 * **The one shape stored under `tenant:host:<host>`** (F-018-al).
 *
 * Two services answer "which tenant owns this address": `auth-service`, for
 * every signed-in request, and `tenant-service`, for every public route. Before
 * this file they cached *different* shapes — `auth-service` wrote this one, and
 * `tenant-service` read the row fresh every time.
 *
 * **Why they must share the key rather than hold one each.** The entry is
 * invalidated explicitly, not by TTL: creating, verifying, switching or
 * deleting a `tenant_domain` row deletes it (ADR-0025), and the TTL below is
 * only a backstop against a writer that forgot. A second key under a second
 * name is a second thing to delete at every one of those call sites, and the
 * one that gets missed outlives a change of owner — which is a request served
 * as the host's *previous* tenant, the cross-tenant leak the invalidation
 * exists to prevent. One key has no such call site to miss.
 *
 * Sharing the key means sharing the shape, because a value either service
 * cannot recognise is a silent permanent miss for it. Hence this file: the
 * type, the validator and the miss marker in one place, imported by both.
 */

/** A tenant reduced to what resolution needs, plus the owner admitted from another tenant (ADR-0059). */
export interface CachedTenantRow {
  id: string;
  slug: string;
  ownerUserId: string;
}

/**
 * What a host resolves to: the tenant, plus what that door is *for* and who
 * holds it. Every field is a fact about the door, which is why none of them
 * belong to the `tenant:id:<id>` entry — a claim names a tenant, and a tenant
 * has no single purpose.
 */
export type HostSurface = CachedTenantRow & {
  purpose: TenantDomainPurpose;
  /** Whether the platform issued the host or the reseller proved it (F-018-ag). */
  domainType: TenantDomainType;
  /** Who owns the host's tenant (ADR-0063), which `doorClosed` turns on. */
  tenantType: TenantType;
};

/**
 * The marker for "this was looked up and there is nothing", stored so a
 * stranger's host costs one Redis read rather than one database read. It has to
 * be a value Redis can hold and JSON cannot produce, because a missing key and
 * a cached `null` mean opposite things: *not looked up yet* and *looked up,
 * answers nothing*. Collapsing them would send every unknown host to Postgres —
 * which, on an unauthenticated route, is the flood F-018-al closed.
 */
export const HOST_SURFACE_MISS = '-';

const PURPOSES: readonly string[] = ['panel', 'subscription', 'assets'];
const DOMAIN_TYPES: readonly string[] = ['subdomain', 'custom_domain'];
const TENANT_TYPES: readonly string[] = ['platform_owner', 'reseller'];

/**
 * A cached value carries a tenant at all. An entry written before its owner was
 * cached — a host entry before ADR-0059, an id entry before F-061-k — lacks
 * `ownerUserId` and re-reads, as a purpose-less one did (F-066-q).
 */
export function isCachedTenantRow(value: unknown): value is CachedTenantRow {
  const row = value as CachedTenantRow | null;
  return (
    typeof row === 'object' &&
    row !== null &&
    typeof row.id === 'string' &&
    typeof row.slug === 'string' &&
    typeof row.ownerUserId === 'string'
  );
}

/**
 * …and, for a host entry, a purpose, a domain type *and* a tenant type this
 * code still recognises.
 *
 * **The shape is checked, not asserted, and that is what carries a new field
 * across a deploy** (F-066-q, F-018-ag, ADR-0063): every entry written before
 * the field existed parses fine and lacks it, and a surface whose purpose is
 * unknown must not be treated as a panel one. Failing the check re-reads the
 * row and overwrites the entry, so the old shape drains itself within one
 * lookup per host instead of needing a keyspace bump.
 */
export function isHostSurface(value: unknown): value is HostSurface {
  const surface = value as HostSurface;
  return (
    isCachedTenantRow(value) &&
    PURPOSES.includes(surface.purpose as string) &&
    DOMAIN_TYPES.includes(surface.domainType as string) &&
    TENANT_TYPES.includes(surface.tenantType as string)
  );
}
