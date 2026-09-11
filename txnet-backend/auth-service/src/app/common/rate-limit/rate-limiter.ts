/**
 * Moved to `shared-core` (F-092-r, D-24) so `billing-service` limits its routes
 * with the same counter. This path re-exports it, as F-094's moves did, so no
 * call site changed; the store it counts in is bound in `auth.module.ts`.
 */
export { RateLimiter, type RateLimitResult } from '@txnet-backend/shared-core';
