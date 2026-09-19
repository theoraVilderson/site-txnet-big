import { EventEmitter } from 'events';
import { ConfigService } from '@nestjs/config';
import {
  NotificationClient,
  PERMISSIONS_CHANNEL,
  PermissionNotificationsListener,
} from './permission-notifications.listener';
import type { PermissionStateStore } from './permission-state.store';
import type { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { TokenService } from '../token.service';

/**
 * The writer half of ADR-0043 (F-101-b). The gate compares a token's `permHash`
 * with what this writes, so the invariant that matters is the one no other test
 * can see: **what it writes for a role is exactly what `TokenService` mints for
 * a user of that role.** If the two ever computed differently, every token on the
 * platform would read as stale the moment this ran.
 *
 * The rest are the ways a listener fails silently: listening after recomputing
 * (a change in the gap is lost), a notification it cannot read taking the
 * process down, and a Postgres that is not up yet failing the boot.
 */
class FakeClient extends EventEmitter implements NotificationClient {
  readonly calls: string[] = [];
  constructor(private readonly failConnect = false) {
    super();
  }
  async connect() {
    this.calls.push('connect');
    if (this.failConnect) throw new Error('connection refused');
  }
  async query(sql: string) {
    this.calls.push(sql);
  }
  async end() {
    this.calls.push('end');
  }
}

const ROLES = [
  { id: 'role-admin', rolePermissions: [{ permission: { key: 'worker.manage' } }, { permission: { key: 'user.read' } }] },
  { id: 'role-user', rolePermissions: [] },
];

function harness(clients: FakeClient[] = [new FakeClient()]) {
  const order: string[] = [];
  const written = new Map<string, string>();
  const prisma = {
    role: {
      findMany: vi.fn(async () => {
        order.push('recompute');
        return ROLES;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ROLES.find((r) => r.id === where.id) ?? null),
    },
  };
  const store = {
    writeRole: vi.fn(async (roleId: string, hash: string) => void written.set(`role:${roleId}`, hash)),
    writeUserRole: vi.fn(async (userId: string, roleId: string) => void written.set(`user:${userId}`, roleId)),
  };
  let next = 0;
  const factory = vi.fn(() => {
    const client = clients[Math.min(next++, clients.length - 1)];
    const query = client.query.bind(client);
    client.query = async (sql: string) => {
      order.push(sql);
      return query(sql);
    };
    return client;
  });
  const listener = new PermissionNotificationsListener(
    prisma as unknown as CrossTenantPrismaService,
    store as unknown as PermissionStateStore,
    factory,
  );
  return { listener, prisma, store, written, order, factory };
}

const tokens = new TokenService({
  get: (key: string, fallback?: unknown) =>
    ({ JWT_ACCESS_SECRET: 'spec-secret', JWT_ACCESS_TTL_SEC: 900 } as Record<string, unknown>)[key] ?? fallback,
} as unknown as ConfigService);

describe('PermissionNotificationsListener', () => {
  afterEach(() => vi.useRealTimers());

  it('writes for a role exactly the fingerprint a token minted for that role carries', async () => {
    const { listener, written } = harness();

    await listener.handle(JSON.stringify({ kind: 'role', roleId: 'role-admin' }));

    const minted = tokens.verify(
      tokens.signAccessToken(
        { id: 'user-1', tenantId: 't-1', roleId: 'role-admin', role: { name: 'Admin', rolePermissions: ROLES[0].rolePermissions } },
        'session-1',
      ),
    );
    expect(written.get('role:role-admin')).toBe(minted.permHash);
  });

  it('writes the role a user moved to', async () => {
    const { listener, written } = harness();

    await listener.handle(JSON.stringify({ kind: 'user', userId: 'user-9', roleId: 'role-user' }));

    expect(written.get('user:user-9')).toBe('role-user');
  });

  it('recomputes every role when a permission key is renamed', async () => {
    const { listener, written } = harness();

    await listener.handle(JSON.stringify({ kind: 'all' }));

    expect([...written.keys()].sort()).toEqual(['role:role-admin', 'role:role-user']);
  });

  it.each([
    ['not JSON', 'role-admin'],
    ['an unknown kind', JSON.stringify({ kind: 'tenant', tenantId: 't-1' })],
    ['a role without an id', JSON.stringify({ kind: 'role' })],
    ['nothing at all', undefined],
  ])('drops a notification that is %s without throwing', async (_label, payload) => {
    const { listener, store } = harness();

    await expect(listener.handle(payload)).resolves.toBeUndefined();
    expect(store.writeRole).not.toHaveBeenCalled();
    expect(store.writeUserRole).not.toHaveBeenCalled();
  });

  it('LISTENs before it recomputes, so a change in between is never lost', async () => {
    const { listener, order } = harness();

    await listener.start();

    expect(order).toEqual([`LISTEN ${PERMISSIONS_CHANNEL}`, 'recompute']);
  });

  it('does not fail the boot when Postgres is down, and tries again later', async () => {
    vi.useFakeTimers();
    const down = new FakeClient(true);
    const up = new FakeClient();
    const { listener, factory, written } = harness([down, up]);

    await expect(listener.start()).resolves.toBeUndefined();
    expect(written.size).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(up.calls).toContain(`LISTEN ${PERMISSIONS_CHANNEL}`);
    expect(written.size).toBe(2);
    await listener.onModuleDestroy();
  });

  it('applies what arrives on the connection it is listening on', async () => {
    const client = new FakeClient();
    const { listener, written } = harness([client]);
    await listener.start();
    written.clear();

    client.emit('notification', { payload: JSON.stringify({ kind: 'user', userId: 'user-3', roleId: 'role-admin' }) });
    await vi.waitFor(() => expect(written.get('user:user-3')).toBe('role-admin'));
    await listener.onModuleDestroy();
  });
});
