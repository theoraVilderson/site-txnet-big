import {
  UnscopedRedisKeys,
  createScopedRedisKeys,
} from '@txnet-backend/shared-core';

import { TenantContext } from '../tenant-context/tenant-context';

/**
 * This service's view of the one key catalogue
 * (`shared-core/src/lib/redis/keys.ts`, ADR-0036, C-03).
 *
 * The names moved; the ~200 call sites did not. What stayed behind is the one
 * thing that could not move: the ambient tenant scope.
 *
 * **Why the scope is supplied here rather than living in `shared-core`.**
 * `TenantContext` is request-scoped (ADR-0024) and exists only in this process
 * — `worker-service` handles broker messages with no request, and
 * `gateway-service` and `auth-handler` hold no tenant at all. Moving it into a
 * shared library would drag a request-scoped mechanism into three processes
 * that have no requests. Passing it in keeps ADR-0024's actual guarantee
 * intact: the builder still cannot be called without a tenant, because the
 * lookup happens per call, inside the key function.
 */
const scope = {
  /**
   * Throws when there is no tenant in scope, for the same reason `withTenant`
   * does — an unscoped key is a cross-tenant collision, and failing loudly is
   * the only safe default (`tenant-context/contract.md` rule 3).
   */
  tenant: (what: string) => TenantContext.current(what).id,
  /**
   * Never throws. An unresolved host is what a flood looks like and must stay
   * countable while `TenantGuard` answers it a 404. `none` is a literal no
   * tenant id can equal, so the unresolved bucket is unreachable from inside a
   * tenant.
   */
  tenantOrNone: () => TenantContext.currentOrNull()?.id ?? 'none',
};

export const RedisKeys = {
  ...UnscopedRedisKeys,
  ...createScopedRedisKeys(scope),
} as const;

export { RedisTtl } from '@txnet-backend/shared-core';
