import { runWithTenant } from '@txnet-backend/shared-core';

import { endUserRoom } from './end-user-room';
import { UserImportService, usernameBase } from './user-import.service';

vi.mock('./end-user-room', async (actual) => ({ ...(await actual<typeof import('./end-user-room')>()), endUserRoom: vi.fn() }));

/**
 * F-201-e (D-63): an import's commit finds or creates the tenant's user for
 * each source client by its `remoteIdentity`. What fails silently here: a
 * second run that creates the same people again, a username that collides
 * with a real account (the batch dies on P2002 for 200 people), an import
 * that walks past the reseller's end-user cap, and a deleted person revived
 * by an import nobody asked to revive them.
 */
describe('UserImportService.findOrCreate', () => {
  const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';

  type Row = { id: string; username: string | null; remoteIdentity: string | null; deletedAt: Date | null };

  const build = (opts: { users?: Row[]; room?: number | null } = {}) => {
    const users: Row[] = [...(opts.users ?? [])];
    const order: string[] = [];
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      $executeRaw: vi.fn(async (sql: TemplateStringsArray) => order.push(sql.join('?').includes('advisory') ? 'lock' : 'bind')),
      user: {
        findMany: vi.fn(async (args: { where: { remoteIdentity?: { in: string[] }; OR?: Array<{ username: { startsWith: string } }> } }) => {
          const { remoteIdentity, OR } = args.where;
          if (remoteIdentity) return users.filter((u) => u.remoteIdentity !== null && remoteIdentity.in.includes(u.remoteIdentity));
          return users.filter((u) => OR?.some((o) => u.username?.startsWith(o.username.startsWith)));
        }),
        createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
          order.push('create');
          created.push(...args.data);
          return { count: args.data.length };
        }),
      },
    };
    const prisma = {
      role: { findFirst: vi.fn(async () => ({ id: 'role-user' })) },
      $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)),
    };
    vi.mocked(endUserRoom).mockResolvedValue(opts.room === undefined ? null : opts.room);
    const service = new UserImportService(prisma as never);
    const run = (batch: Array<{ remoteIdentity: string; label: string }>) => runWithTenant({ id: TENANT } as never, () => service.findOrCreate(batch));
    return { run, tx, created, order };
  };

  it('answers the user it already made, and creates nothing on a second run', async () => {
    const { run, tx } = build({ users: [{ id: 'u-1', username: 'ali', remoteIdentity: 'marzban:https://old.example:ali', deletedAt: null }] });
    const answer = await run([{ remoteIdentity: 'marzban:https://old.example:ali', label: 'ali' }]);
    expect(answer).toEqual({ users: [{ remoteIdentity: 'marzban:https://old.example:ali', userId: 'u-1', created: false }], refused: [] });
    expect(tx.user.createMany).not.toHaveBeenCalled();
  });

  it('creates a user with no phone, the label as name, under the lock, in the tenant', async () => {
    const { run, created, order } = build();
    const answer = await run([{ remoteIdentity: 'x:https://h:7', label: 'Reza.K' }]);
    expect(order).toEqual(['bind', 'lock', 'create']);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ tenantId: TENANT, username: 'reza_k', fullName: 'Reza.K', roleId: 'role-user', remoteIdentity: 'x:https://h:7' });
    expect(created[0]).not.toHaveProperty('phoneNumber');
    expect(answer.users).toEqual([{ remoteIdentity: 'x:https://h:7', userId: created[0].id, created: true }]);
  });

  it('suffixes a username already taken in the tenant, or taken earlier in the same batch', async () => {
    const { run, created } = build({ users: [{ id: 'u-9', username: 'ali', remoteIdentity: null, deletedAt: null }] });
    await run([
      { remoteIdentity: 'r1', label: 'ali' },
      { remoteIdentity: 'r2', label: 'ALI' },
    ]);
    expect(created.map((c) => c.username)).toEqual(['ali_2', 'ali_3']);
  });

  it('refuses past the end-user cap per person, never the whole batch', async () => {
    const { run, created } = build({ room: 1 });
    const answer = await run([
      { remoteIdentity: 'r1', label: 'one' },
      { remoteIdentity: 'r2', label: 'two' },
    ]);
    expect(created).toHaveLength(1);
    expect(answer.refused).toEqual([{ remoteIdentity: 'r2', reason: 'over_cap' }]);
  });

  it('does not revive a deleted person', async () => {
    const { run, created } = build({ users: [{ id: 'u-1', username: 'ali', remoteIdentity: 'r1', deletedAt: new Date() }] });
    const answer = await run([{ remoteIdentity: 'r1', label: 'ali' }]);
    expect(created).toHaveLength(0);
    expect(answer).toEqual({ users: [], refused: [{ remoteIdentity: 'r1', reason: 'deleted' }] });
  });

  it('creates one user for a remote identity named twice in one batch', async () => {
    const { run, created } = build();
    const answer = await run([
      { remoteIdentity: 'r1', label: 'ali' },
      { remoteIdentity: 'r1', label: 'ali' },
    ]);
    expect(created).toHaveLength(1);
    expect(answer.users).toHaveLength(1);
  });
});

describe('usernameBase', () => {
  it.each([
    ['Reza.K', 'reza_k'],
    ['  ali  ', 'ali'],
    ['علی', 'user'],
    ['ab', 'user_ab'],
    ['a'.repeat(50), 'a'.repeat(32)],
    ['__x__', 'user_x'],
  ])('%s -> %s', (label, base) => expect(usernameBase(label)).toBe(base));
});
