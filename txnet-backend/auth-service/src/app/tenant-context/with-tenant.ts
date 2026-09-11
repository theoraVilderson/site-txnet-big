/**
 * Moved to `shared-core` (F-094) so every service that talks to Postgres binds
 * the tenant the same way. This path re-exports it so its importers need no
 * edit; new code imports from `@txnet-backend/shared-core`.
 */
export {
  TENANT_SCOPED_MODELS,
  bindTenantThroughTransaction,
  scopeArgs,
  tenantScopeQueryMap,
  withTenant,
} from '@txnet-backend/shared-core';
export type {
  TenantBindableClient,
  TenantBinder,
  TenantScopedModel,
} from '@txnet-backend/shared-core';
