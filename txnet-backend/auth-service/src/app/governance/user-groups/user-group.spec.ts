/**
 * User groups (F-114-j, governance).
 *
 * What would break silently here, and nowhere else:
 *  - a reseller's group holding another tenant's user, a reseller, or "every
 *    reseller" — the one way a tenant's discount or campaign would reach past
 *    it; only the platform owner's group may (the trigger is the backstop);
 *  - "every reseller" admitting the platform owner itself, or a reseller member
 *    admitting that reseller's users — a tenant member is the reseller, not
 *    its customers, so a consumer asks for the one it means;
 *  - a group a discount rule names being deleted from under the rule;
 *  - a write that leaves no audit row.
 */
import { Prisma, TenantType, UserGroupKind, UserGroupMemberType } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { UserGroupAdminService, UserGroupRefused } from './user-group-admin.service';
import { admitsTenant, admitsUser, groupRefusal, memberRefusal } from './user-group';

const PLATFORM = '00000000-0000-4000-8000-000000000001';
const RESELLER = '11111111-1111-4111-8111-111111111111';
const OTHER_RESELLER = '22222222-2222-4222-8222-222222222222';
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWN_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GROUP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const AT = new Date('2026-09-25T10:00:00Z');

const user = (userId: string) => ({ memberType: UserGroupMemberType.user, userId, memberTenantId: null });
const reseller = (memberTenantId: string) => ({ memberType: UserGroupMemberType.tenant, userId: null, memberTenantId });

describe('membership', () => {
  it('a user is in a group only when named — a reseller member is not its customers', () => {
    const members = [user(OWN_USER), reseller(OTHER_RESELLER)];
    expect(admitsUser(members, OWN_USER)).toBe(true);
    expect(admitsUser(members, OTHER_USER)).toBe(false);
  });

  it('a reseller is in a group when named, or when the group holds every reseller — never the owner itself', () => {
    const named = { tenantId: PLATFORM, allTenants: false };
    expect(admitsTenant(named, [reseller(RESELLER)], RESELLER)).toBe(true);
    expect(admitsTenant(named, [reseller(RESELLER)], OTHER_RESELLER)).toBe(false);

    const every = { tenantId: PLATFORM, allTenants: true };
    expect(admitsTenant(every, [], OTHER_RESELLER)).toBe(true);
    expect(admitsTenant(every, [], PLATFORM)).toBe(false);
  });
});

describe('what a group may hold', () => {
  const resellerGroup = { tenantId: RESELLER, platform: false, allTenants: false };
  const platformGroup = { tenantId: PLATFORM, platform: true, allTenants: false };

  it('only the platform owner’s group holds every reseller', () => {
    expect(groupRefusal(false, { allTenants: true })).toBe('platform_only');
    expect(groupRefusal(true, { allTenants: true })).toBeNull();
    expect(groupRefusal(false, { allTenants: false })).toBeNull();
  });

  it.each([
    ['a reseller group: its own user', resellerGroup, { type: 'user', userTenantId: RESELLER }, null],
    ['a reseller group: another tenant’s user reads as missing', resellerGroup, { type: 'user', userTenantId: OTHER_RESELLER }, 'user_not_found'],
    ['a reseller group: a user that does not exist', resellerGroup, { type: 'user', userTenantId: null }, 'user_not_found'],
    ['a reseller group: a reseller', resellerGroup, { type: 'tenant', tenantId: OTHER_RESELLER, exists: true }, 'platform_only'],
    ['the platform’s group: another tenant’s user', platformGroup, { type: 'user', userTenantId: RESELLER }, null],
    ['the platform’s group: a reseller', platformGroup, { type: 'tenant', tenantId: RESELLER, exists: true }, null],
    ['the platform’s group: a reseller that does not exist', platformGroup, { type: 'tenant', tenantId: RESELLER, exists: false }, 'tenant_not_found'],
    ['the platform’s group: the platform itself', platformGroup, { type: 'tenant', tenantId: PLATFORM, exists: true }, 'not_a_reseller'],
    ['the platform’s every-reseller group: one more reseller', { ...platformGroup, allTenants: true }, { type: 'tenant', tenantId: RESELLER, exists: true }, 'all_tenants_conflict'],
  ] as const)('%s', (_why, group, candidate, reason) => {
    expect(memberRefusal(group, candidate)).toBe(reason);
  });
});

describe('UserGroupAdminService', () => {
  type Row = Record<string, unknown>;

  function build(o: { tenant: string; users?: Array<{ id: string; tenantId: string }>; tenants?: string[]; groups?: Row[]; ruleNamesGroup?: boolean }) {
    const audits: Row[] = [];
    const groups: Row[] = [...(o.groups ?? [])];
    const members: Row[] = [];
    const users = o.users ?? [
      { id: OWN_USER, tenantId: o.tenant },
      { id: OTHER_USER, tenantId: OTHER_RESELLER },
    ];
    const tenantRows = [PLATFORM, ...(o.tenants ?? [RESELLER, OTHER_RESELLER])];
    const typeOf = (id: string) => (id === PLATFORM ? TenantType.platform_owner : TenantType.reseller);
    const userFindMany = (scoped: boolean) => async ({ where }: { where: { id: { in: string[] } } }) =>
      users.filter((u) => where.id.in.includes(u.id) && (!scoped || u.tenantId === o.tenant));

    const tx = {
      $executeRaw: async () => 0,
      tenant: { findUnique: async ({ where }: { where: { id: string } }) => ({ tenantType: typeOf(where.id) }) },
      // The app pool: RLS shows this tenant's users only.
      user: { findMany: userFindMany(true) },
      userGroup: {
        findUnique: async ({ where }: { where: { id: string } }) => groups.find((g) => g.id === where.id) ?? null,
        findFirst: async ({ where }: { where: { name: string } }) => groups.find((g) => g.name === where.name) ?? null,
        create: async ({ data }: { data: Row }) => {
          const row = { id: GROUP, kind: UserGroupKind.manual, allTenants: false, createdAt: AT, updatedAt: AT, ...data };
          groups.push(row);
          return row;
        },
        delete: async () => {
          if (o.ruleNamesGroup) {
            throw new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' });
          }
          return groups.pop();
        },
      },
      userGroupMember: {
        count: async () => members.filter((m) => m.memberType === UserGroupMemberType.tenant).length,
        createMany: async ({ data }: { data: Row[] }) => {
          members.push(...data);
          return { count: data.length };
        },
      },
      adminAuditLog: { create: async ({ data }: { data: Row }) => audits.push(data) },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
    // The cross-tenant pool: every tenant's users and every reseller.
    const all = {
      user: { findMany: userFindMany(false) },
      tenant: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => tenantRows.filter((id) => where.id.in.includes(id)).map((id) => ({ id })) },
    };
    return { service: new UserGroupAdminService(prisma as never, all as never), audits, groups, members };
  }

  const as = (tenant: string) => <T>(fn: () => Promise<T>) => runWithTenant({ id: tenant }, fn);
  const actorOf = (tenantId: string) => ({ adminId: ADMIN, tenantId, ip: '203.0.113.9' });
  const group = (tenantId: string, allTenants = false) => ({ id: GROUP, tenantId, name: 'VIP', kind: UserGroupKind.manual, allTenants, createdAt: AT, updatedAt: AT });

  it('a reseller creates a group of its own and audits it; "every reseller" is refused', async () => {
    const { service, audits, groups } = build({ tenant: RESELLER });
    const view = await as(RESELLER)(() => service.create(actorOf(RESELLER), { name: 'VIP' }));
    expect(groups[0]).toMatchObject({ tenantId: RESELLER, name: 'VIP', createdByAdminId: ADMIN });
    expect(view).toMatchObject({ id: GROUP, name: 'VIP', allTenants: false });
    expect(audits).toEqual([expect.objectContaining({ tenantId: RESELLER, action: 'user_group_create', targetEntityType: 'user_group', targetEntityId: GROUP })]);

    const other = build({ tenant: RESELLER });
    await expect(as(RESELLER)(() => other.service.create(actorOf(RESELLER), { name: 'All', allTenants: true }))).rejects.toMatchObject({ reason: 'platform_only' });
    expect(other.groups).toEqual([]);
    expect(other.audits).toEqual([]);
  });

  it('a reseller cannot add another tenant’s user or a reseller, and nothing is written', async () => {
    for (const input of [{ userIds: [OTHER_USER] }, { tenantIds: [OTHER_RESELLER] }]) {
      const { service, members, audits } = build({ tenant: RESELLER, groups: [group(RESELLER)] });
      const run = as(RESELLER)(() => service.addMembers(actorOf(RESELLER), GROUP, input));
      await expect(run).rejects.toBeInstanceOf(UserGroupRefused);
      expect(members).toEqual([]);
      expect(audits).toEqual([]);
    }
  });

  it('the platform owner adds a reseller and another tenant’s user, both on its own group’s rows', async () => {
    const { service, members, audits } = build({ tenant: PLATFORM, groups: [group(PLATFORM)] });
    const out = await as(PLATFORM)(() => service.addMembers(actorOf(PLATFORM), GROUP, { userIds: [OTHER_USER], tenantIds: [RESELLER] }));

    expect(out).toEqual({ added: 2 });
    expect(members).toEqual([
      expect.objectContaining({ groupId: GROUP, tenantId: PLATFORM, memberType: UserGroupMemberType.user, userId: OTHER_USER }),
      expect.objectContaining({ groupId: GROUP, tenantId: PLATFORM, memberType: UserGroupMemberType.tenant, memberTenantId: RESELLER }),
    ]);
    expect(audits).toEqual([expect.objectContaining({ tenantId: PLATFORM, action: 'user_group_member_add', targetEntityId: GROUP })]);
  });

  it('a group a discount rule names is not deleted', async () => {
    const { service, audits } = build({ tenant: RESELLER, groups: [group(RESELLER)], ruleNamesGroup: true });
    await expect(as(RESELLER)(() => service.remove(actorOf(RESELLER), GROUP))).rejects.toMatchObject({ reason: 'group_in_use' });
    expect(audits).toEqual([]);
  });
});
