import type { IncomingMessage } from 'node:http';
import { IdentityHeaders } from '@txnet-backend/shared-core';
import { RedisKeys } from '../redis/redis.keys';
import { ConnectionRegistry, type Connection } from './connection.registry';
import { identityFrom } from './identity';
import { PermissionSocketWatch } from './permission-watch';

/**
 * The invariant this item turns on (RT-1-n, `realtime/contract.md` "The
 * session outlives the token"): **a socket holds only the permissions its
 * holder has now.** The 60 s tick asks forward-auth's own question
 * (`stalePermissions`, ADR-0043 / ADR-0138) and closes a socket whose answer
 * moved on, so the panel refreshes and re-subscribes under what is held now.
 *
 * Both ways it breaks are silent: a socket that keeps a role taken away goes
 * on hearing that role's channels, and one closed when nothing changed loops
 * through refresh and reconnect every minute. So the store below is a real,
 * if tiny, keyspace and the test asserts which sockets end up closed.
 */

class FakeRedis {
  readonly values = new Map<string, string>();
  failing = false;
  reads = 0;

  async mget(...keys: string[]): Promise<(string | null)[]> {
    this.reads++;
    if (this.failing) throw new Error('connection lost');
    return keys.map((key) => this.values.get(key) ?? null);
  }

  role(roleId: string, hash: string): void {
    this.values.set(RedisKeys.rolePermissions(roleId), hash);
  }

  holds(userId: string, roleId: string): void {
    this.values.set(RedisKeys.userRole(userId), roleId);
  }

  person(userId: string, hash: string): void {
    this.values.set(RedisKeys.userPermissions(userId), hash);
  }
}

function connection(id: string, grant: { userId?: string; roleId?: string; permHash?: string } | null): Connection {
  return {
    id,
    identity: grant
      ? {
          userId: grant.userId ?? 'u-1',
          tenantId: 't-1',
          roleId: grant.roleId ?? 'r-1',
          sessionId: `s-${id}`,
          permissions: [],
          ...(grant.permHash ? { permHash: grant.permHash } : {}),
        }
      : null,
    address: '203.0.113.1',
    socket: { readyState: 1, send: () => undefined } as never,
    subscriptions: new Set<string>(),
    alive: true,
  };
}

function setup(...connections: Connection[]) {
  const registry = new ConnectionRegistry();
  for (const c of connections) registry.add(c);
  const redis = new FakeRedis();
  const watch = new PermissionSocketWatch(registry, redis as never);
  const closed = async () => (await watch.sweep()).map((c) => c.id).sort();
  return { redis, closed };
}

describe('PermissionSocketWatch.sweep', () => {
  it("closes a socket whose role's permissions moved on", async () => {
    const { redis, closed } = setup(connection('a', { permHash: 'h1' }));
    redis.role('r-1', 'h1');
    expect(await closed()).toEqual([]);

    redis.role('r-1', 'h2');
    expect(await closed()).toEqual(['a']);
  });

  it('closes a socket whose holder was given another role', async () => {
    const { redis, closed } = setup(connection('a', { permHash: 'h1' }));
    redis.role('r-1', 'h1');
    redis.holds('u-1', 'r-2');
    expect(await closed()).toEqual(['a']);
  });

  it("lets the person's own fingerprint decide when they have one (ADR-0138)", async () => {
    const { redis, closed } = setup(connection('a', { permHash: 'mine' }));
    // The role moved on, but this person's answer is their own and unchanged.
    redis.role('r-1', 'role-now');
    redis.person('u-1', 'mine');
    expect(await closed()).toEqual([]);

    redis.person('u-1', 'mine-now');
    expect(await closed()).toEqual(['a']);
  });

  it('closes nobody when Redis knows nothing', async () => {
    // An empty keyspace, a flush, a role not yet reported: not a change.
    const { closed } = setup(connection('a', { permHash: 'h1' }));
    expect(await closed()).toEqual([]);
  });

  it('compares only the role for a socket the gate gave no fingerprint', async () => {
    // A gate or a Traefik list without X-Perm-Hash: the hash is unknown, and
    // closing on it would loop the panel through refresh every tick.
    const { redis, closed } = setup(connection('a', {}));
    redis.role('r-1', 'h1');
    expect(await closed()).toEqual([]);

    redis.holds('u-1', 'r-2');
    expect(await closed()).toEqual(['a']);
  });

  it('leaves every socket open when Redis cannot be read', async () => {
    const { redis, closed } = setup(connection('a', { permHash: 'h1' }));
    redis.role('r-1', 'h2');
    redis.failing = true;
    expect(await closed()).toEqual([]);
  });

  it('asks once per person and role, not once per tab, and never for an anonymous socket', async () => {
    const { redis, closed } = setup(
      connection('tab-1', { permHash: 'old' }),
      connection('tab-2', { permHash: 'new' }),
      connection('other', { userId: 'u-2', roleId: 'r-9', permHash: 'h9' }),
      connection('anon', null),
    );
    redis.role('r-1', 'new');
    // The tab opened before the change closes; the one opened after it stays.
    expect(await closed()).toEqual(['tab-1']);
    expect(redis.reads).toBe(2);
  });
});

describe('identityFrom — what the tick compares', () => {
  const upgrade = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
  const signedIn = {
    [IdentityHeaders.userId.toLowerCase()]: 'u-1',
    [IdentityHeaders.tenantId.toLowerCase()]: 't-1',
    [IdentityHeaders.roleId.toLowerCase()]: 'r-1',
    [IdentityHeaders.sessionId.toLowerCase()]: 's-1',
  };

  it("reads the token's role and fingerprint off the gate's headers", () => {
    const identity = identityFrom(upgrade({ ...signedIn, [IdentityHeaders.permHash.toLowerCase()]: 'h1' }));
    expect(identity).toMatchObject({ roleId: 'r-1', permHash: 'h1' });
  });

  it('admits a socket without the fingerprint, and leaves it unknown', () => {
    const identity = identityFrom(upgrade(signedIn));
    expect(identity).not.toBeNull();
    expect(identity?.permHash).toBeUndefined();
  });
});
