/**
 * The tenant family of `UnscopedRedisKeys` (ADR-0036, C-03): what a host or an
 * id resolves to, a tenant's status and the channel that announces it, and a
 * release flag's state. Spread into `UnscopedRedisKeys` in `keys.ts`, which
 * stays the one place keys are looked up; kept apart so that file stays under
 * its size cap (C-20). Call sites use `UnscopedRedisKeys.*`.
 */
export const TenantRedisKeys = {
  /**
   * Which tenant a normalized host resolves to, or a marker that it resolves to
   * none. Shared rather than in-process because it is invalidated *explicitly*
   * — creating, verifying, switching or deleting a `tenant_domain` row deletes
   * this key, and a per-replica cache would leave every other replica serving
   * the old mapping until its TTL ran out (ADR-0025). A stale mapping after a
   * domain switch is a cross-tenant leak.
   */
  tenantByHost: (host: string) => `tenant:host:${host}`,
  /**
   * Which tenant a claimed tenant id proves to, or a marker that it proves to
   * none. Same lifetime rules as `tenantByHost`: a deleted tenant must stop
   * answering a still-signed token's claim without waiting for a TTL.
   */
  tenantById: (tenantId: string) => `tenant:id:${tenantId}`,
  /**
   * A tenant's status and `graceEndsAt`, as `TenantStatusGuard` reads it
   * (F-018-f). No TTL: written by `tenant-service`'s `TenantStatusListener` on a
   * Postgres notification and recomputed for every tenant on each connect, the
   * same lifetime as `rolePermissions`. A missing key refuses nobody.
   */
  tenantStatus: (tenantId: string) => `tenant:status:${tenantId}`,

  /**
   * **A pub/sub channel, not a key** (F-018-r). `TenantStatusListener` publishes
   * a tenant id on it after rewriting that tenant's `tenantStatus`, and
   * `gateway-service` closes the tenant's sockets if the new status no longer
   * allows `read`. The body names a tenant and nothing else: the gateway
   * re-reads the key, so a message carries no authority of its own. The prefix
   * is applied by hand on both sides, as for `realtimeFanout`.
   */
  tenantStatusChanged: () => 'tenant:status-changed',

  /**
   * One release flag's state, cached whole (OPS-1-ag): its stage and every
   * reseller's exception. Unscoped: a flag is the platform's, and every
   * service asks it for whichever tenant it is serving. Deleted by each write.
   */
  releaseFlag: (key: string) => `release-flag:${key}`,
} as const;
