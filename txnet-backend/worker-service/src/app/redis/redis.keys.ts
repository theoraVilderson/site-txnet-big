/**
 * This service's view of the one key catalogue
 * (`shared-core/src/lib/redis/keys.ts`, ADR-0036, C-03).
 *
 * Only the unscoped families, and for a reason specific to this process: there
 * is no request here to have resolved a tenant, so `TenantContext` does not
 * exist (ADR-0024 scopes a request). `tenantRuns` takes its tenant id from the
 * tick message instead — the message is the only thing that knows whose work
 * this is.
 */
export { UnscopedRedisKeys as RedisKeys } from '@txnet-backend/shared-core';
