/**
 * One person's groups, as their page shows them (GR-1-u, ADR-0139 (1)): every
 * group of the tenant, whether the person is in it and until when, and whether
 * this caller may put them in or take them out.
 *
 * What would break silently here, and nowhere else:
 *  - a group that gives keys offered to a caller who does not hold them all —
 *    the write refuses `key_not_held`, but the page would offer a dead button;
 *  - an ended membership shown as current;
 *  - "every reseller" (retiring, GR-1-n) offered as a group a person joins.
 */
import { runWithTenant } from '@txnet-backend/shared-core';

import { UserGroupPersonService } from './user-group-person.service';
import { personGroupsOf } from './user-group';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ALI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY = 24 * 60 * 60 * 1000;

const vip = { id: 'g-vip', name: 'VIP', allTenants: false, keys: [] as string[] };
const support = { id: 'g-support', name: 'Support', allTenants: false, keys: ['user.read', 'user.write'] };
const resellers = { id: 'g-all', name: 'Every reseller', allTenants: true, keys: [] as string[] };

describe('personGroupsOf', () => {
  const now = new Date('2026-10-14T12:00:00Z');

  it('lists every group by name, marking the live memberships with their end', () => {
    const end = new Date(now.getTime() + DAY);
    const out = personGroupsOf([vip, support], [{ groupId: 'g-support', expiresAt: end }], ['*'], now);
    expect(out.map((g) => g.name)).toEqual(['Support', 'VIP']);
    expect(out[0]).toMatchObject({ id: 'g-support', member: true, expiresAt: end, givesKeys: true, mayChange: true });
    expect(out[1]).toMatchObject({ id: 'g-vip', member: false, expiresAt: null, givesKeys: false, mayChange: true });
  });

  it('reads an ended membership as not a member', () => {
    const out = personGroupsOf([vip], [{ groupId: 'g-vip', expiresAt: new Date(now.getTime() - DAY) }], ['*'], now);
    expect(out[0]).toMatchObject({ member: false, expiresAt: null });
  });

  it('lets a caller change a group that gives keys only when they hold every one', () => {
    const out = personGroupsOf([vip, support], [], ['user.read'], now);
    expect(out.find((g) => g.id === 'g-support')?.mayChange).toBe(false);
    expect(out.find((g) => g.id === 'g-vip')?.mayChange).toBe(true);
  });

  it('never offers a group of every reseller', () => {
    expect(personGroupsOf([vip, resellers], [], ['*'], now).map((g) => g.id)).toEqual(['g-vip']);
  });
});

describe('UserGroupPersonService.of', () => {
  it('reads the groups and that person`s memberships in the caller`s tenant', async () => {
    const tx = {
      $executeRaw: vi.fn(async () => undefined),
      userGroup: {
        findMany: vi.fn(async () => [
          { id: 'g-support', name: 'Support', allTenants: false, roleId: null, role: null, permissions: [{ permission: { key: 'user.read' } }] },
        ]),
      },
      userGroupMember: { findMany: vi.fn(async () => [{ groupId: 'g-support', expiresAt: null }]) },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const service = new UserGroupPersonService(prisma as never);

    const out = await runWithTenant({ id: TENANT } as never, () => service.of({ permissions: ['user.write'] }, ALI));

    expect(tx.userGroupMember.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: ALI, memberType: 'user' } }));
    expect(out).toEqual([{ id: 'g-support', name: 'Support', member: true, expiresAt: null, givesKeys: true, mayChange: false }]);
  });
});
