import { serializeTenantStatusState, type TenantStatusValue } from '@txnet-backend/shared-core';
import { RedisKeys } from '../redis/redis.keys';
import { ConnectionRegistry, type Connection } from './connection.registry';
import { TenantSocketWatch } from './tenant-status';

/**
 * The invariant this item turns on (F-018-r, `tenant/rules.md`): **a socket
 * exists only while its tenant's status allows `read`.** Refused at the
 * upgrade, and closed — without waiting for a session to expire, which
 * terminating does not do — the moment the tenant stops allowing it.
 *
 * Every way it breaks is silent: a terminated reseller's panel simply keeps
 * receiving pushes. So the fakes here are a real, if tiny, store and pub/sub
 * bus, and the test asserts which sockets end up closed.
 */

const KEY_PREFIX = 'txnet:auth:v3:';
const WIRE = `${KEY_PREFIX}${RedisKeys.tenantStatusChanged()}`;

class FakeRedis {
  readonly keyPrefix = KEY_PREFIX;
  readonly values = new Map<string, string>();
  readonly failing = new Set<string>();
  readonly subscribed = new Set<string>();
  private readonly handlers: ((channel: string, raw: string) => void)[] = [];

  readonly subscriber = {
    on: (event: 'message', handler: (channel: string, raw: string) => void) => {
      if (event === 'message') this.handlers.push(handler);
      return this.subscriber;
    },
    subscribe: async (channel: string) => void this.subscribed.add(channel),
    unsubscribe: async (channel: string) => void this.subscribed.delete(channel),
  };

  async get(key: string): Promise<string | null> {
    if (this.failing.has(key)) throw new Error('connection lost');
    return this.values.get(key) ?? null;
  }

  status(tenantId: string, status: TenantStatusValue, graceEndsAt: string | null = null): void {
    this.values.set(RedisKeys.tenantStatus(tenantId), serializeTenantStatusState({ status, graceEndsAt }));
  }

  /** What Redis does: deliver only on a channel that was actually subscribed. */
  publish(channel: string, raw: string): void {
    if (!this.subscribed.has(channel)) return;
    for (const handler of this.handlers) handler(channel, raw);
  }
}

function connection(id: string, tenantId: string | null): Connection {
  return {
    id,
    identity: tenantId ? { userId: `u-${id}`, tenantId, sessionId: `s-${id}`, permissions: [] } : null,
    address: '203.0.113.1',
    socket: { readyState: 1, send: () => undefined } as never,
    subscriptions: new Set<string>(),
    alive: true,
  };
}

function harness() {
  const redis = new FakeRedis();
  const registry = new ConnectionRegistry();
  const closed: string[] = [];
  const watch = new TenantSocketWatch(registry, redis as never);
  const onClose = (connections: Connection[]) => closed.push(...connections.map((c) => c.id));
  return { redis, registry, watch, closed, onClose };
}

/** Let the handler's async read settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TenantSocketWatch.admits — the upgrade', () => {
  it('admits trial, active and suspended tenants: a suspended tenant still reads', async () => {
    const { redis, watch } = harness();
    redis.status('t-trial', 'trial');
    redis.status('t-active', 'active');
    redis.status('t-susp', 'suspended', '2026-09-20T00:00:00.000Z');

    expect(await watch.admits('t-trial')).toBe(true);
    expect(await watch.admits('t-active')).toBe(true);
    expect(await watch.admits('t-susp')).toBe(true);
  });

  it('refuses a terminated tenant', async () => {
    const { redis, watch } = harness();
    redis.status('t-gone', 'terminated');

    expect(await watch.admits('t-gone')).toBe(false);
  });

  it('refuses nobody on a missing, unreadable or unreachable key (F-101-b trade)', async () => {
    const { redis, watch } = harness();
    redis.values.set(RedisKeys.tenantStatus('t-junk'), 'not json');
    redis.failing.add(RedisKeys.tenantStatus('t-down'));

    expect(await watch.admits('t-none')).toBe(true);
    expect(await watch.admits('t-junk')).toBe(true);
    expect(await watch.admits('t-down')).toBe(true);
  });
});

describe('TenantSocketWatch — closing a tenant that stopped allowing read', () => {
  it('closes that tenant’s sockets at once when its change is published, and no one else’s', async () => {
    const { redis, registry, watch, closed, onClose } = harness();
    for (const c of [connection('a1', 't-a'), connection('a2', 't-a'), connection('b1', 't-b'), connection('anon', null)]) {
      registry.add(c);
    }
    await watch.listen(onClose);
    expect(redis.subscribed.has(WIRE)).toBe(true);

    redis.status('t-a', 'terminated');
    redis.status('t-b', 'terminated'); // changed too, but nobody published it yet
    redis.publish(WIRE, 't-a');
    await flush();

    expect(closed.sort()).toEqual(['a1', 'a2']);
  });

  it('closes nothing when the published change still allows read (suspension)', async () => {
    const { redis, registry, watch, closed, onClose } = harness();
    registry.add(connection('a1', 't-a'));
    await watch.listen(onClose);

    redis.status('t-a', 'suspended', '2026-09-20T00:00:00.000Z');
    redis.publish(WIRE, 't-a');
    await flush();

    expect(closed).toEqual([]);
  });

  it('ignores a message on any other channel, and a body that is not a tenant id', async () => {
    const { redis, registry, watch, closed, onClose } = harness();
    registry.add(connection('a1', 't-a'));
    redis.status('t-a', 'terminated');
    await watch.listen(onClose);

    redis.subscribed.add(`${KEY_PREFIX}realtime:user:u-a1`);
    redis.publish(`${KEY_PREFIX}realtime:user:u-a1`, 't-a');
    redis.publish(WIRE, '');
    await flush();

    expect(closed).toEqual([]);
  });

  it('the sweep is the backstop for a lost message: every held tenant is re-read, an unreachable one is left open', async () => {
    const { redis, registry, watch } = harness();
    for (const c of [connection('a1', 't-a'), connection('b1', 't-b'), connection('c1', 't-c'), connection('anon', null)]) {
      registry.add(c);
    }
    redis.status('t-a', 'terminated');
    redis.status('t-b', 'active');
    redis.status('t-c', 'terminated');
    redis.failing.add(RedisKeys.tenantStatus('t-c'));

    const closing = await watch.sweep();

    expect(closing.map((c) => c.id)).toEqual(['a1']);
  });
});
