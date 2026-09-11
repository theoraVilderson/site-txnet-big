import { BotRedisKeys } from '@txnet-backend/shared-core';

/**
 * This service's view of the one key catalogue
 * (`shared-core/src/lib/redis/keys.ts`, ADR-0036, C-03).
 *
 * The bot families are scoped by the integration the update came through rather
 * than by an ambient tenant, so they need nothing from this process — the shim
 * is a rename. See `BotRedisKeys` for why every chat key names its integration
 * and not just its platform (F-320).
 */
export const RedisKeys = BotRedisKeys;

export { RedisTtl } from '@txnet-backend/shared-core';
