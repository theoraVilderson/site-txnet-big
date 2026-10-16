import { Injectable, Logger } from '@nestjs/common';
import { permissionsStale } from '@txnet-backend/shared-core';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis.keys';
import { ConnectionRegistry, type Connection } from './connection.registry';

/**
 * A socket holds only the permissions its holder has now (RT-1-n).
 *
 * `forward-auth` refuses a stale token per request (`stalePermissions`,
 * ADR-0043 / ADR-0138), and the panel refreshes on it. A socket asks the gate
 * once, at the upgrade, and lives for hours — so without this a role taken
 * away keeps that role's channels for the socket's life. The session re-check
 * tick asks {@link sweep}, and the gateway closes what it returns with `4401`:
 * the panel's refresh then mints a token under what is held now, and the
 * reconnect re-subscribes with it.
 *
 * **A missing or unreadable answer closes nobody**, the gate's own trade: an
 * empty keyspace is not a change, and a Redis outage is not evidence that
 * everyone's role moved. A socket the gate gave no fingerprint is compared on
 * its role alone, since closing on an unknown would loop it every tick.
 */
@Injectable()
export class PermissionSocketWatch {
  private readonly logger = new Logger(PermissionSocketWatch.name);

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly redis: RedisService,
  ) {}

  /** The signed-in connections whose permissions moved on. One read per person and role, not per tab. */
  async sweep(): Promise<Connection[]> {
    const closing: Connection[] = [];
    for (const { userId, roleId, connections } of this.byGrant()) {
      let roleHash: string | null, currentRole: string | null, personHash: string | null;
      try {
        [roleHash, currentRole, personHash] = await this.redis.mget(
          RedisKeys.rolePermissions(roleId),
          RedisKeys.userRole(userId),
          RedisKeys.userPermissions(userId),
        );
      } catch (err) {
        this.logger.error(`permission re-check failed for user ${userId}: ${(err as Error).message}`);
        continue;
      }
      for (const connection of connections) {
        const { permHash } = connection.identity;
        const now = permHash
          ? { roleHash, currentRole, personHash }
          : { roleHash: null, currentRole, personHash: null };
        if (permissionsStale({ roleId, permHash }, now)) closing.push(connection);
      }
    }
    return closing;
  }

  /** Signed-in connections grouped by the person and the role their token names. */
  private byGrant(): { userId: string; roleId: string; connections: Connection[] }[] {
    const groups = new Map<string, { userId: string; roleId: string; connections: Connection[] }>();
    for (const connection of this.registry.all()) {
      if (!connection.identity) continue;
      const { userId, roleId } = connection.identity;
      const key = `${userId}\n${roleId}`;
      if (!groups.has(key)) groups.set(key, { userId, roleId, connections: [] });
      groups.get(key).connections.push(connection);
    }
    return [...groups.values()];
  }
}
