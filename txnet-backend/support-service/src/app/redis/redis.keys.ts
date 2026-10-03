/**
 * This service's view of the one key catalogue
 * (`shared-core/src/lib/redis/keys.ts`, ADR-0036, C-03). The support channel
 * proof is unscoped: the gateway that reads it holds no tenant (F-034).
 */
export { UnscopedRedisKeys as RedisKeys } from '@txnet-backend/shared-core';
