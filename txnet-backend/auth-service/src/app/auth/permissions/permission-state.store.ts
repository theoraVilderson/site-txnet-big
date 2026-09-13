import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys } from '../../redis/redis.keys';
import type { AuthClaims } from '../token.service';

/**
 * What a role grants now, and which role a user holds now, as Redis knows it
 * (ADR-0043).
 *
 * `AuthGuard` asks it on every call, the way `auth-handler` asks the same two
 * keys at the gate. The rule is identical on both sides on purpose — a token
 * the gate refuses must not be accepted by this process's own guarded routes,
 * which are not behind the gate.
 */
@Injectable()
export class PermissionStateStore {
  constructor(private readonly redis: RedisService) {}

  /**
   * Whether the permissions a token was minted with are no longer true: the
   * user holds another role now, or that role's set has a new fingerprint.
   *
   * **A missing key is not a change.** Nothing refuses a token because Redis
   * knows nothing — an empty keyspace, a flush, or a role Postgres has not yet
   * reported. The session check is the one that fails closed.
   */
  async isStale(claims: Pick<AuthClaims, 'sub' | 'roleId' | 'permHash'>): Promise<boolean> {
    const [currentHash, currentRole] = await this.redis.client.mget(
      RedisKeys.rolePermissions(claims.roleId),
      RedisKeys.userRole(claims.sub),
    );
    if (currentRole && currentRole !== claims.roleId) return true;
    return !!currentHash && currentHash !== (claims.permHash ?? '');
  }

  /**
   * Record a role's current fingerprint (F-101-b). No TTL: it stays true until
   * Postgres reports the next change, and an expiry would only turn a known
   * fingerprint back into an unknown one that refuses nobody.
   */
  async writeRole(roleId: string, fingerprint: string): Promise<void> {
    await this.redis.set(RedisKeys.rolePermissions(roleId), fingerprint);
  }

  /** Record the role a user holds now (F-101-b). No TTL, for the same reason. */
  async writeUserRole(userId: string, roleId: string): Promise<void> {
    await this.redis.set(RedisKeys.userRole(userId), roleId);
  }
}
