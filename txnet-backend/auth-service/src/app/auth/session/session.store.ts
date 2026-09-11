import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys } from '../../redis/redis.keys';

/**
 * The marker's payload, as written by `register`. Read back only to find the
 * owner; anything unparseable means the index entry is left behind — a
 * dangling id `dropAllForUser` deletes harmlessly — rather than the drop
 * failing.
 */
function markerOf(raw: string | null): LiveSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { userId?: unknown; scopeKey?: unknown };
    if (typeof parsed.userId !== 'string') return null;
    return {
      userId: parsed.userId,
      scopeKey: typeof parsed.scopeKey === 'string' ? parsed.scopeKey : null,
    };
  } catch {
    return null;
  }
}

function ownerOf(raw: string | null): string | null {
  return markerOf(raw)?.userId ?? null;
}

/**
 * What the marker says about a live session.
 *
 * `scopeKey` is the switch scope the session was minted under (ADR-0015), and
 * it is here rather than only in Postgres because ADR-0032 makes it decide the
 * scope of every authenticated request — a read `AuthGuard` was already doing.
 * `null` for a session minted before that shipped, which is why every caller
 * falls back to the request's own scope rather than refusing.
 */
export type LiveSession = { userId: string; scopeKey: string | null };

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
    scopeKey?: string | null,
  ): Promise<void> {
    const indexKey = RedisKeys.userSessions(userId);
    await this.redis.client
      .multi()
      .set(
        RedisKeys.session(sessionId),
        JSON.stringify({ userId, revoked: false, scopeKey: scopeKey ?? null }),
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

  /**
   * The live session behind an id, or `null` if there is none.
   *
   * `AuthGuard` reads this instead of {@link isActive}: it is the same single
   * round trip, and it answers both questions the guard has — is the session
   * still alive, and which switch scope was it minted under (ADR-0032).
   */
  async read(sessionId: string): Promise<LiveSession | null> {
    return markerOf(await this.redis.get(RedisKeys.session(sessionId)));
  }

  /**
   * Drop a single session, pruning it from its user's index either way.
   * Pass `userId` when the caller already knows it; without it the owner is
   * read back off the marker, which carries it.
   */
  async drop(sessionId: string, userId?: string): Promise<void> {
    if (userId) {
      await this.redis.client
        .multi()
        .del(RedisKeys.session(sessionId))
        .srem(RedisKeys.userSessions(userId), sessionId)
        .exec();
      return;
    }

    // GETDEL, so the session is revoked in the same command that reveals its
    // owner: revocation must not be contingent on the payload being readable.
    const raw = await this.redis.client.getdel(RedisKeys.session(sessionId));
    const owner = ownerOf(raw);
    if (owner) {
      await this.redis.client.srem(RedisKeys.userSessions(owner), sessionId);
    }
  }

  /** Drop every session belonging to a user (used on password reset, etc.). */
  async dropAllForUser(userId: string): Promise<void> {
    const indexKey = RedisKeys.userSessions(userId);
    const ids = await this.redis.client.smembers(indexKey);
    await this.redis.del(...ids.map((id) => RedisKeys.session(id)), indexKey);
  }
}
