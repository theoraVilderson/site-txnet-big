/**
 * A group's members changed at once (GR-1-i, user 2026-10-10): the panel holds
 * every add, removal and end move as a draft and saves them together. What
 * would break silently:
 *  - **half a save**: three writes in three transactions leave the group half
 *    changed when the second is refused. Here the whole list is checked before
 *    anything is written, and written in one transaction, so a refusal writes
 *    nothing — and `staff_members_max` weighs the end state, so a reseller at
 *    its cap can swap one person for another in one save;
 *  - **a list that contradicts itself**: the same person added and removed,
 *    or an end moved on someone the same save removes — refused
 *    `member_conflict`, never resolved by order;
 *  - **a removal of someone not in the group** passing as done.
 */
import { UserGroupMemberType } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { AccessReader } from '../../auth/permissions/access.reader';
import { UserGroupAdminService, UserGroupRefused } from './user-group-admin.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const GROUP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LEAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SARA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REZA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const DAY = 24 * 60 * 60 * 1000;
const keys = (...k: string[]) => k.map((key) => ({ permission: { key } }));

type Row = { userId: string; expiresAt: Date | null; createdAt: Date };

function harness(start: Row[] = [], groupKeys: string[] = ['coupon.manage'], shops: { tenantId: string; expiresAt: Date | null }[] = []) {
  const members: Row[] = [...start];
  // Reseller members, for the platform's own group (GR-1-l).
  const tenants = shops.map((t) => ({ ...t }));
  const audits: { action: string; oldValue: unknown; newValue: unknown }[] = [];
  const outbox: Record<string, unknown>[] = [];
  const live = (r: Row) => r.expiresAt === null || r.expiresAt > new Date();
  const group = { id: GROUP, tenantId: TENANT, name: 'Support', kind: 'manual', allTenants: false, roleId: null, role: null, permissions: keys(...groupKeys), createdAt: new Date(), updatedAt: new Date() };

  const tx = {
    $executeRaw: vi.fn(async () => undefined),
    tenant: { findUnique: vi.fn(async () => ({ tenantType: 'reseller', ownerUserId: 'u-owner' })) },
    tenantSubscription: { findUnique: vi.fn(async () => null) },
    resellerLimit: { findMany: vi.fn(async () => []) },
    packageLimit: { findMany: vi.fn(async () => []) },
    resellerLimitSetting: { findMany: vi.fn(async () => []) },
    userGroup: { findUnique: vi.fn(async () => group) },
    userGroupMember: {
      findMany: vi.fn(async ({ where, distinct }: { where: { groupId?: string; userId?: { in: string[] }; memberTenantId?: { in: string[] } }; distinct?: string[] }) => {
        if (distinct) return [];
        if (where.memberTenantId) return tenants.filter((t) => where.memberTenantId?.in.includes(t.tenantId)).map((t) => ({ id: `t-${t.tenantId}`, memberTenantId: t.tenantId, expiresAt: t.expiresAt }));
        return members
          .filter((m) => (where.userId ? where.userId.in.includes(m.userId) && live(m) : true))
          .map((m) => ({
            id: `m-${m.userId}`,
            groupId: GROUP,
            userId: m.userId,
            tenantId: TENANT,
            memberType: UserGroupMemberType.user,
            memberTenantId: null,
            expiresAt: m.expiresAt,
            createdAt: m.createdAt,
            group: { id: GROUP, name: group.name, role: null, permissions: group.permissions },
          }));
      }),
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const m = members.find((r) => r.userId === where.userId);
        return m ? { id: `m-${m.userId}`, expiresAt: m.expiresAt } : null;
      }),
      count: vi.fn(async () => members.length),
      createMany: vi.fn(async ({ data }: { data: { userId: string; expiresAt?: Date | null }[] }) => {
        let count = 0;
        for (const d of data) {
          if (members.some((m) => m.userId === d.userId)) continue;
          members.push({ userId: d.userId, expiresAt: d.expiresAt ?? null, createdAt: new Date() });
          count++;
        }
        return { count };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { groupId: string; userId?: string | { in: string[] }; memberTenantId?: { in: string[] } } }) => {
        const ids = typeof where.userId === 'string' ? [where.userId] : (where.userId?.in ?? []);
        const before = members.length;
        for (const id of ids) {
          const i = members.findIndex((m) => m.userId === id);
          if (i >= 0) members.splice(i, 1);
        }
        return { count: before - members.length };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { expiresAt: Date | null } }) => {
        const shop = tenants.find((t) => `t-${t.tenantId}` === where.id);
        if (shop) return Object.assign(shop, { expiresAt: data.expiresAt });
        const m = members.find((r) => `m-${r.userId}` === where.id) as Row;
        m.expiresAt = data.expiresAt;
        return m;
      }),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, tenantId: TENANT, fullName: id === ALI ? 'Ali' : 'Sara', role: id === LEAD ? { rolePermissions: keys('user_group.manage', 'coupon.manage', 'user.read') } : null })),
      ),
    },
    userPermission: { findMany: vi.fn(async () => []) },
    adminAuditLog: {
      create: vi.fn(async ({ data }: { data: { action: string; oldValue: unknown; newValue: unknown } }) => (audits.push(data), { id: `act-${audits.length}` })),
    },
    outboxEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => void outbox.push(data)), createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => void outbox.push(...data)) },
    accessHistory: { createMany: vi.fn(async () => undefined) },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)) };
  const service = new UserGroupAdminService(prisma as never, prisma as never, new AccessReader(prisma as never));
  return { service, members, tenants, audits, outbox, prisma };
}

const lead = (permissions: string[] = ['user_group.manage', 'coupon.manage', 'user.read', 'report.read']) => ({ adminId: LEAD, tenantId: TENANT, ip: '1.1.1.1', permissions });
const inTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);
const reason = (p: Promise<unknown>) => p.then(() => 'none', (e) => (e instanceof UserGroupRefused ? e.reason : String(e)));


describe("a group's members changed in one save (GR-1-i)", () => {
  const later = (days: number) => new Date(Date.now() + days * DAY);

  it('adds each person with their own end, removes, and moves an end, in one transaction', async () => {
    const h = harness([
      { userId: ALI, expiresAt: null, createdAt: new Date() },
      { userId: REZA, expiresAt: null, createdAt: new Date() },
    ]);
    const end = later(10);
    const out = await inTenant(() =>
      h.service.changeMembers(lead(), GROUP, { add: [{ userId: SARA, expiresAt: end }], remove: [{ userId: ALI }], ends: [{ userId: REZA, expiresAt: later(5) }] }),
    );

    expect(out).toEqual({ added: 1, removed: 1, endsMoved: 1 });
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.members.map((m) => m.userId).sort()).toEqual([REZA, SARA].sort());
    expect(h.members.find((m) => m.userId === REZA)?.expiresAt).toBeInstanceOf(Date);
    expect(h.members.find((m) => m.userId === SARA)?.expiresAt).toEqual(end);
    expect(h.audits.map((a) => a.action).sort()).toEqual(['user_group_member_add', 'user_group_member_end_set', 'user_group_member_remove']);
  });

  it('writes nothing when one change is refused', async () => {
    const h = harness([{ userId: ALI, expiresAt: null, createdAt: new Date() }]);
    const refused = await reason(inTenant(() => h.service.changeMembers(lead(), GROUP, { add: [{ userId: SARA, expiresAt: later(-1) }], remove: [{ userId: ALI }], ends: [] })));

    expect(refused).toBe('expiry_past');
    expect(h.members.map((m) => m.userId)).toEqual([ALI]);
    expect(h.audits).toEqual([]);
  });

  it('refuses a removal of someone not in the group, before anything is written', async () => {
    const h = harness([{ userId: ALI, expiresAt: null, createdAt: new Date() }]);
    const refused = await reason(inTenant(() => h.service.changeMembers(lead(), GROUP, { add: [{ userId: SARA }], remove: [{ userId: REZA }], ends: [] })));

    expect(refused).toBe('member_not_found');
    expect(h.members.map((m) => m.userId)).toEqual([ALI]);
  });

  it('refuses a list that names one person twice', async () => {
    const h = harness([{ userId: ALI, expiresAt: null, createdAt: new Date() }]);
    const twice = await reason(inTenant(() => h.service.changeMembers(lead(), GROUP, { add: [{ userId: ALI }], remove: [{ userId: ALI }], ends: [] })));
    const endOfRemoved = await reason(inTenant(() => h.service.changeMembers(lead(), GROUP, { add: [], remove: [{ userId: ALI }], ends: [{ userId: ALI, expiresAt: null }] })));

    expect(twice).toBe('member_conflict');
    expect(endOfRemoved).toBe('member_conflict');
    expect(h.members.map((m) => m.userId)).toEqual([ALI]);
  });

  it("moves a reseller member's end too (GR-1-l)", async () => {
    const ACME = '99999999-9999-4999-8999-999999999999';
    const h = harness([], ['coupon.manage'], [{ tenantId: ACME, expiresAt: null }]);
    const end = later(7);
    const out = await inTenant(() => h.service.changeMembers(lead(), GROUP, { add: [], remove: [], ends: [{ tenantId: ACME, expiresAt: end }] }));

    expect(out.endsMoved).toBe(1);
    expect(h.tenants).toEqual([{ tenantId: ACME, expiresAt: end }]);
    expect(h.audits.map((a) => a.action)).toEqual(['user_group_member_end_set']);
  });
});
