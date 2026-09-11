/**
 * This service's view of the one key catalogue
 * (`shared-core/src/lib/redis/keys.ts`, ADR-0036, C-03).
 *
 * Only the unscoped families: this process holds no tenant of its own, and the
 * three keys it touches — `session:`, `otp:channel:` and the realtime fan-out
 * name — are deliberately not tenant-segmented for exactly that reason. A
 * segment here would build a key that can never match, and a miss reads as
 * "revoked" or "never minted", which refuses the connection with no error on
 * either side.
 *
 * **Read-only from this process.** Nothing here writes a session, extends one,
 * or revokes one; `identity` owns all three, and this gateway re-asks the
 * question `forward-auth` answered at the upgrade because a socket outlives the
 * access token that opened it.
 */
export { UnscopedRedisKeys as RedisKeys } from '@txnet-backend/shared-core';
