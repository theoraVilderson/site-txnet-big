import type { Prisma } from '@prisma/client';
import { findKeyHolders, liveMembership } from './key-holders';

/**
 * Who in a tenant holds one key (ADR-0138), for a query that picks people by
 * a key — the wheel's 80% alert today. The rule is `accessOf`'s for a single
 * key, written as a query: a role holding `*`, or the key from the role, a
 * gift or a group of the tenant that gives it — unless it was taken. A query
 * that reads role rows alone misses a key given to one person and tells
 * someone it was taken from.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';

function fakeTx(memberIds: string[] = []) {
  const asked: { members?: Record<string, unknown>; users?: Record<string, unknown> } = {};
  const tx = {
    userGroupMember: { findMany: async (a: Record<string, unknown>) => ((asked.members = a), memberIds.map((userId) => ({ userId }))) },
    user: { findMany: async (a: Record<string, unknown>) => ((asked.users = a), [{ id: 'u-1' }]) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, asked };
}

describe('findKeyHolders', () => {
  it("counts the key from the role, a gift and the tenant's groups, and never someone it was taken from", async () => {
    const { tx, asked } = fakeTx(['u-grp']);
    expect(await findKeyHolders(tx, TENANT, 'engagement.manage')).toEqual(['u-1']);

    const where = asked.users?.['where'] as { tenantId: string; OR: unknown[] };
    expect(where.tenantId).toBe(TENANT);
    expect(where.OR).toEqual([
      { role: { rolePermissions: { some: { permission: { key: '*' } } } } },
      {
        AND: [
          {
            OR: [
              { role: { rolePermissions: { some: { permission: { key: 'engagement.manage' } } } } },
              { permissionOverrides: { some: { effect: 'give', permission: { key: 'engagement.manage' } } } },
              { id: { in: ['u-grp'] } },
            ],
          },
          { NOT: { permissionOverrides: { some: { effect: 'take', permission: { key: 'engagement.manage' } } } } },
        ],
      },
    ]);
  });

  it("asks only this tenant's user members of groups that give the key, never an every-reseller group", async () => {
    const { tx, asked } = fakeTx();
    await findKeyHolders(tx, TENANT, 'engagement.manage');

    expect(asked.members?.['where']).toMatchObject({
      tenantId: TENANT,
      memberType: 'user',
      group: {
        allTenants: false,
        OR: [
          { role: { rolePermissions: { some: { permission: { key: 'engagement.manage' } } } } },
          { permissions: { some: { permission: { key: 'engagement.manage' } } } },
        ],
      },
    });
  });

  it('narrows by the caller’s own conditions, and is ordered by id', async () => {
    const { tx, asked } = fakeTx();
    await findKeyHolders(tx, TENANT, 'engagement.manage', { deletedAt: null, status: 'active' });
    expect(asked.users).toMatchObject({ where: { AND: [{ deletedAt: null, status: 'active' }] }, select: { id: true }, orderBy: { id: 'asc' } });
  });
});

/** A membership may end (ADR-0139 (3)): an ended one gives nothing, wherever membership is asked. */
describe('liveMembership', () => {
  const NOW = new Date('2026-10-09T12:00:00Z');

  it('is a membership with no end, or one ending after now', () => {
    expect(liveMembership(NOW)).toEqual({ OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }] });
  });

  it('is part of who holds a key through a group', async () => {
    const { tx, asked } = fakeTx();
    await findKeyHolders(tx, TENANT, 'engagement.manage', {}, NOW);
    expect(asked.members?.['where']).toMatchObject(liveMembership(NOW));
  });
});
