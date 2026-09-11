import {
  TenantContext as ScopeReader,
  runWithTenant as openScope,
} from '@txnet-backend/shared-core';
import type { ResolvedTenant } from '../tenant/tenant';

/**
 * This service's door to the ambient tenant scope, which lives in
 * `shared-core` since F-094 so every service holds the one isolation rule
 * (ADR-0024) rather than a copy of it.
 *
 * Not a second scope: every function below reads and writes the one
 * `AsyncLocalStorage` in `shared-core`, the same one `withTenant` reads. What
 * this file adds is only the type. The shared scope carries a `ScopedTenant`
 * (an id), and this service resolves a whole `ResolvedTenant` — so the
 * narrowing back lives here, at the one edge that writes the scope
 * (`TenantContextMiddleware`), and none of the importers of this path had to
 * change. The cast is sound for that reason alone: nothing else in this
 * process opens a scope.
 */
export type { ResolvedTenant };

export {
  TenantContextMissing,
  TenantScopeConflict,
  runAcrossTenants,
} from '@txnet-backend/shared-core';

export const TenantContext = {
  current(what?: string): ResolvedTenant {
    return ScopeReader.current(what) as ResolvedTenant;
  },

  currentOrNull(): ResolvedTenant | null {
    return ScopeReader.currentOrNull() as ResolvedTenant | null;
  },

  /** @deprecated since 2026-09-09 (F-066-m-b) — see `shared-core`. */
  isAcrossTenants(): boolean {
    return ScopeReader.isAcrossTenants();
  },
};

export function runWithTenant<T>(
  tenant: ResolvedTenant | null,
  fn: () => T,
): T {
  return openScope(tenant, fn);
}
