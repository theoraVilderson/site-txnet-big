/**
 * A user group holds access (AC-1-m, ADR-0138): a role of its tenant and/or
 * extra keys, held by its user members while they are members.
 *
 * What would break silently here, and nowhere else:
 *  - a member of another tenant (a platform group's reseller customer)
 *    gaining the platform's keys — the answer counts only the group's own
 *    tenant's members;
 *  - `user_group.manage` alone handing out what its holder does not hold —
 *    by attaching it, or by adding someone (themselves included) to a group
 *    that already holds it;
 *  - a member whose answer moved and was never told (`access.changed`).
 */
import { UserGroupMemberType } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { AccessReader } from '../../auth/permissions/access.reader';
import { UserGroupAdminService, UserGroupRefused } from './user-group-admin.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const GROUP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LEAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SARA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FAR = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const keys = (...k: string[]) => k.map((key) => ({ permission: { key } }));
const ROLES: Record<string, { id: string; tenantId: string | null; name: string; rolePermissions: { permission: { key: string } }[] }> = {
  desk: { id: 'role-desk', tenantId: TENANT, name: 'Desk', rolePermissions: keys('ticket.read', 'ticket.reply') },
  super: { id: 'role-super', tenantId: null, name: 'SuperAdmin', rolePermissions: keys('*') },
  user: { id: 'role-user', tenantId: null, name: 'user', rolePermissions: [] },
};

function harness(start: { roleId?: string | null; keys?: string[]; members?: string[]; allTenants?: boolean } = {}) {
  const group = { id: GROUP, tenantId: TENANT, name: 'Desk crew', kind: 'manual', allTenants: start.allTenants ?? false, roleId: start.roleId ?? null, createdAt: new Date(), updatedAt: new Date() };
  const groupKeys = new Set(start.keys ?? []);
  const members = new Set(start.members ?? [ALI]);
  const people: Record<string, { id: string; tenantId: string; roleId: string }> = {
    [ALI]: { id: ALI, tenantId: TENANT, roleId: 'role-user' },
    [SARA]: { id: SARA, tenantId: TENANT, roleId: 'role-user' },
    [FAR]: { id: FAR, tenantId: OTHER_TENANT, roleId: 'role-user' },
    [LEAD]: { id: LEAD, tenantId: TENANT, roleId: 'role-desk' },
  };
  const roleOf = (id: string | null) => Object.values(ROLES).find((r) => r.id === id) ?? null;
  const outbox: Record<string, unknown>[] = [];
  const audits: string[] = [];
  const history: Record<string, unknown>[] = [];

  const tx = {
    $executeRaw: vi.fn(async () => undefined),
    tenant: { findUnique: vi.fn(async () => ({ tenantType: 'reseller', ownerUserId: 'u-owner' })) },
    role: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => roleOf(where.id)) },
    permission: { findMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) => where.key.in.filter((k) => k !== 'no.such').map((key) => ({ id: `perm-${key}`, key }))) },
    userGroup: {
      findUnique: vi.fn(async () => ({ ...group, role: roleOf(group.roleId), permissions: keys(...groupKeys) })),
      update: vi.fn(async ({ data }: { data: { roleId: string | null } }) => {
        group.roleId = data.roleId;
        return group;
      }),
    },
    userGroupPermission: {
      deleteMany: vi.fn(async () => void groupKeys.clear()),
      createMany: vi.fn(async ({ data }: { data: { permissionId: string }[] }) => void data.forEach((d) => groupKeys.add(d.permissionId.slice(5)))),
    },
    userGroupMember: {
      groupBy: vi.fn(async () => [{ groupId: GROUP, memberType: UserGroupMemberType.user, _count: { _all: members.size } }]),
      findMany: vi.fn(async ({ where }: { where: { userId?: { in: string[] }; groupId?: string } }) => {
        const has = group.roleId !== null || groupKeys.size > 0;
        return [...members]
          .filter((u) => (where.userId ? where.userId.in.includes(u) : true))
          .filter(() => (where.userId ? has && !group.allTenants : true))
          .map((u) => ({
            id: `m-${u}`,
            userId: u,
            tenantId: TENANT,
            memberType: UserGroupMemberType.user,
            memberTenantId: null,
            createdAt: new Date('2026-10-01'),
            group: { id: GROUP, name: group.name, role: roleOf(group.roleId), permissions: keys(...groupKeys) },
          }));
      }),
      createMany: vi.fn(async ({ data }: { data: { userId: string }[] }) => {
        let count = 0;
        for (const d of data) if (!members.has(d.userId)) (members.add(d.userId), count++);
        return { count };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => ({ count: members.delete(where.userId) ? 1 : 0 })),
      count: vi.fn(async () => members.size),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => people[id]).map((id) => ({ ...people[id], role: roleOf(people[id].roleId) })),
      ),
    },
    userPermission: { findMany: vi.fn(async () => []) },
    adminAuditLog: { create: vi.fn(async ({ data }: { data: { action: string } }) => (audits.push(data.action), { id: `act-${audits.length}` })) },
    outboxEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => void outbox.push(data)),
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => void outbox.push(...data)),
    },
    accessHistory: { createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => void history.push(...data)) },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)) };
  const service = new UserGroupAdminService(prisma as never, prisma as never, new AccessReader(prisma as never));
  const reader = new AccessReader(prisma as never);
  const answer = async (id: string) => (await reader.ofIds([id])).get(id);
  return { service, outbox, audits, history, answer, members, group, groupKeys };
}

const lead = (permissions: string[] = ['user_group.manage', 'ticket.read', 'ticket.reply', 'coupon.manage']) => ({
  adminId: LEAD,
  tenantId: TENANT,
  ip: '1.1.1.1',
  permissions,
});
const inTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);
const reason = (p: Promise<unknown>) => p.then(() => 'none', (e) => (e instanceof UserGroupRefused ? e.reason : String(e)));

describe('a group holds access (AC-1-m)', () => {
  it("gives every user member of its tenant the role's keys and the extra keys, and tells each what they gained", async () => {
    const h = harness();
    const view = await inTenant(() => h.service.setAccess(lead(), GROUP, { roleId: 'role-desk', keys: ['coupon.manage'] }));

    expect(view.access).toEqual({ roleId: 'role-desk', roleName: 'Desk', keys: ['coupon.manage'] });
    expect(new Set((await h.answer(ALI))?.keys)).toEqual(new Set(['ticket.read', 'ticket.reply', 'coupon.manage']));
    expect(h.audits).toEqual(['user_group_access_set']);
    expect(h.outbox).toHaveLength(1);
    expect(h.outbox[0]).toMatchObject({ aggregateId: ALI, payload: { cause: 'group_access', given: ['coupon.manage', 'ticket.read', 'ticket.reply'], taken: [] } });
    // AC-1-p: the one person moved remembers it, against the act's audit row.
    expect(h.history).toEqual([expect.objectContaining({ userId: ALI, cause: 'group_access', auditLogId: `act-${h.audits.length}`, given: ['coupon.manage', 'ticket.read', 'ticket.reply'] })]);
  });

  it('gives nothing to a member of another tenant', async () => {
    const h = harness({ roleId: 'role-desk' });
    // A platform group's reseller customer: the membership row is the group's tenant, the person is not.
    expect((await h.answer(FAR))?.keys).toEqual([]);
  });

  it.each([
    ['a key the writer does not hold', { roleId: null, keys: ['wallet.manual_adjust'] }, 'key_not_held'],
    ["a role holding a key the writer does not hold", { roleId: 'role-desk', keys: [] }, 'key_not_held'],
    ['a role holding `*`', { roleId: 'role-super', keys: [] }, 'key_not_grantable'],
    ['a platform key', { roleId: null, keys: ['platform.tenant.manage'] }, 'key_not_grantable'],
    ['a key that does not exist', { roleId: null, keys: ['no.such'] }, 'key_unknown'],
  ])('refuses %s', async (_label, access, why) => {
    const h = harness();
    const writer = _label.startsWith('a role holding a key') ? lead(['user_group.manage', 'ticket.read']) : lead();
    await expect(reason(inTenant(() => h.service.setAccess(writer, GROUP, access)))).resolves.toBe(why);
    expect(h.outbox).toEqual([]);
  });

  it('refuses access on a group of every reseller: its members are resellers, not people', async () => {
    const h = harness({ allTenants: true });
    await expect(reason(inTenant(() => h.service.setAccess(lead(), GROUP, { roleId: null, keys: ['coupon.manage'] })))).resolves.toBe(
      'access_on_resellers',
    );
  });

  it('adding a member of a group that holds access moves their answer and tells them', async () => {
    const h = harness({ keys: ['coupon.manage'], members: [] });
    await inTenant(() => h.service.addMembers(lead(), GROUP, { userIds: [SARA] }));

    expect((await h.answer(SARA))?.keys).toEqual(['coupon.manage']);
    expect(h.outbox[0]).toMatchObject({ aggregateId: SARA, payload: { cause: 'group_access', given: ['coupon.manage'] } });
  });

  it('removing one tells them what they lost', async () => {
    const h = harness({ keys: ['coupon.manage'], members: [ALI] });
    await inTenant(() => h.service.removeMember(lead(), GROUP, { userId: ALI }));

    expect((await h.answer(ALI))?.keys).toEqual([]);
    expect(h.outbox[0]).toMatchObject({ aggregateId: ALI, payload: { cause: 'group_access', taken: ['coupon.manage'] } });
  });

  it("refuses a member change on a group whose keys the writer does not hold — or user_group.manage alone would grant them", async () => {
    const h = harness({ keys: ['wallet.manual_adjust'], members: [] });
    await expect(reason(inTenant(() => h.service.addMembers(lead(), GROUP, { userIds: [SARA] })))).resolves.toBe('key_not_held');
    expect(h.members.size).toBe(0);
  });

  it('refuses adding yourself to a group that holds access', async () => {
    const h = harness({ keys: ['coupon.manage'], members: [] });
    await expect(reason(inTenant(() => h.service.addMembers(lead(), GROUP, { userIds: [LEAD] })))).resolves.toBe('no_authority');
  });

  it('says which members receive what it gives: its own tenant\'s people, never another tenant\'s (AC-1-o)', async () => {
    const h = harness({ roleId: 'role-desk', members: [ALI, FAR] });
    const page = await inTenant(() => h.service.members(lead(), GROUP, 1, 50));

    const receives = Object.fromEntries(page.items.map((m) => [m.userId, m.receivesAccess]));
    expect(receives).toEqual({ [ALI]: true, [FAR]: false });
  });
});
