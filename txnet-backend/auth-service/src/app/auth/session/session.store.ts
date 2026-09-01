import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys } from '../../redis/redis.keys';

/**
 * Owns the session keyspace in Redis: the per-session "is this still alive?"
 * marker that {@link AuthGuard} checks on every request, plus a per-user index
 * SET so all of a user's sessions can be revoked without scanning the keyspace.
 *
 * Postgres remains the source of truth for sessions; this is the fast-path
 * revocation check.
 */
@Injectable()
export class SessionStore {
  constructor(private readonly redis: RedisService) {}

  /** Record a freshly created session and add it to the user's index. */
  async register(
    sessionId: string,
    userId: string,
    ttlSec: number,
  ): Promise<void> {
    const indexKey = RedisKeys.userSessions(userId);
    await this.redis.client
      .multi()
      .set(
        RedisKeys.session(sessionId),
        JSON.stringify({ userId, revoked: false }),
        'EX',
        ttlSec,
      )
      .sadd(indexKey, sessionId)
      .expire(indexKey, ttlSec)
      .exec();
  }

  isActive(sessionId: string): Promise<boolean> {
    return this.redis.exists(RedisKeys.session(sessionId));
  }

  /** Drop a single session. Pass `userId` to also prune it from the index. */
  async drop(sessionId: string, userId?: string): Promise<void> {
    if (!userId) {
      await this.redis.del(RedisKeys.session(sessionId));
      return;
    }
    await this.redis.client
      .multi()
      .del(RedisKeys.session(sessionId))
      .srem(RedisKeys.userSessions(userId), sessionId)
      .exec();
  }

  /** Drop every session belonging to a user (used on password reset, etc.). */
  async dropAllForUser(userId: string): Promise<void> {
    const indexKey = RedisKeys.userSessions(userId);
    const ids = await this.redis.client.smembers(indexKey);
    await this.redis.del(...ids.map((id) => RedisKeys.session(id)), indexKey);
  }
}
