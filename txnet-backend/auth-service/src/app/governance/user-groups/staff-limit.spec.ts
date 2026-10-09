/**
 * A reseller's `staff_members_max` counts people, not seats (GR-1-b, ADR-0139
 * Consequences): everyone who holds a reseller key through one of the
 * reseller's groups, while the membership lasts, each once however many such
 * groups they are in.
 *
 * What would break silently here, and nowhere else:
 *  - a member add, or a key put on a group, that takes the reseller past its
 *    limit — the seat was the only thing counted, and the seat admits nobody now;
 *  - a person in two such groups counted twice, or an ended membership counted;
 *  - a group that gives no reseller key ("VIP", a discount audience) counted:
 *    its members are customers, not staff;
 *  - the platform's staff refused on a reseller's behalf (they are not bounded).
 */
import { UserGroupMemberType } from '@prisma/client';
import { RESELLER_KEYS, ResellerLimitReached, runWithTenant } from '@txnet-backend/shared-core';

import { AccessReader } from '../../auth/permissions/access.reader';
import { UserGroupAdminService } from './user-group-admin.service';

const RESELLER = '11111111-1111-4111-8111-111111111111';
const SUPPORT = 'dddddddd-dddd-4ddd-8ddd-000000000001';
const FINANCE = 'dddddddd-dddd-4ddd-8ddd-000000000002';
const VIP = 'dddddddd-dddd-4ddd-8ddd-000000000003';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALI = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const SARA = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
const REZA = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000003';

type Member = { groupId: string; userId: string; expiresAt: Date | null };
const RESELLER_KEY = new Set<string>(RESELLER_KEYS);
const keys = (...k: string[]) => k.map((key) => ({ permission: { key } }));

/** A reseller with a limit of `limit` staff, three groups, and `members` in them. */
function harness(limit: number, members: Member[]) {
  const groups: Record<string, { name: string; keys: Set<string> }> = {
    [SUPPORT]: { name: 'Support', keys: new Set(['user.read']) },
    [FINANCE]: { name: 'Finance', keys: new Set(['report.read']) },
    [VIP]: { name: 'VIP', keys: new Set() },
  };
  const live = (m: Member, now: Date) => m.expiresAt === null || m.expiresAt > now;
  const givesResellerKey = (groupId: string) => [...groups[groupId].keys].some((k) => RESELLER_KEY.has(k));
  const outbox: unknown[] = [];

  const tx = {
    $executeRaw: vi.fn(async () => undefined),
    tenant: { findUnique: vi.fn(async () => ({ tenantType: 'reseller', ownerUserId: OWNER })) },
    tenantSubscription: { findUnique: vi.fn(async () => null) },
    resellerLimit: { findMany: vi.fn(async () => [{ key: 'staff_members_max', value: limit }]) },
    packageLimit: { findMany: vi.fn(async () => []) },
    resellerLimitSetting: { findMany: vi.fn(async () => []) },
    permission: { findMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) => where.key.in.map((key) => ({ id: `perm-${key}`, key }))) },
    role: { findFirst: vi.fn(async () => null) },
    userGroup: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        tenantId: RESELLER,
        name: groups[where.id].name,
        kind: 'manual',
        allTenants: false,
        roleId: null,
        role: null,
        permissions: keys(...groups[where.id].keys),
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      update: vi.fn(async () => undefined),
    },
    userGroupPermission: {
      deleteMany: vi.fn(async ({ where }: { where: { groupId: string } }) => void groups[where.groupId].keys.clear()),
      createMany: vi.fn(async ({ data }: { data: { groupId: string; permissionId: string }[] }) => void data.forEach((d) => groups[d.groupId].keys.add(d.permissionId.slice(5)))),
    },
    userGroupMember: {
      groupBy: vi.fn(async () => []),
      findMany: vi.fn(async ({ where, distinct }: { where: { groupId?: string; userId?: { in: string[] }; group?: unknown }; distinct?: string[] }) => {
        const now = new Date();
        // The count's read: a reseller key, through a group, while it lasts — once per person.
        if (distinct) {
          const ids = members.filter((m) => live(m, now) && givesResellerKey(m.groupId)).map((m) => m.userId);
          return [...new Set(ids)].map((userId) => ({ userId }));
        }
        return members
          .filter((m) => (where.groupId ? m.groupId === where.groupId : true))
          .filter((m) => (where.userId ? where.userId.in.includes(m.userId) && live(m, now) && groups[m.groupId].keys.size > 0 : true))
          .map((m) => ({
            userId: m.userId,
            tenantId: RESELLER,
            memberType: UserGroupMemberType.user,
            group: { id: m.groupId, name: groups[m.groupId].name, role: null, permissions: keys(...groups[m.groupId].keys) },
          }));
      }),
      createMany: vi.fn(async ({ data }: { data: { groupId: string; userId: string }[] }) => {
        let count = 0;
        for (const d of data) {
          if (members.some((m) => m.groupId === d.groupId && m.userId === d.userId)) continue;
          members.push({ groupId: d.groupId, userId: d.userId, expiresAt: null });
          count++;
        }
        return { count };
      }),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, tenantId: RESELLER, role: null }))),
      count: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length),
    },
    userPermission: { findMany: vi.fn(async () => []) },
    adminAuditLog: { create: vi.fn(async () => ({ id: 'act-1' })) },
    outboxEvent: { create: vi.fn(async ({ data }: { data: unknown }) => void outbox.push(data)), createMany: vi.fn(async ({ data }: { data: unknown[] }) => void outbox.push(...data)) },
    accessHistory: { createMany: vi.fn(async () => undefined) },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)) };
  const service = new UserGroupAdminService(prisma as never, prisma as never, new AccessReader(prisma as never));
  return { service, outbox, members };
}

const owner = (as: 'owner' | 'member' | 'staff' = 'owner') => ({ adminId: OWNER, tenantId: RESELLER, ip: '1.1.1.1', permissions: [...RESELLER_KEYS], as });
const inReseller = <T>(fn: () => Promise<T>) => runWithTenant({ id: RESELLER }, fn);
const refusal = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof ResellerLimitReached ? { reason: e.reason, ...e.facts } : String(e)));

describe("a reseller's staff limit counts people holding its keys through its groups (GR-1-b)", () => {
  it('refuses a member add past the limit, with the figures, and tells no one', async () => {
    const h = harness(2, [
      { groupId: SUPPORT, userId: ALI, expiresAt: null },
      { groupId: FINANCE, userId: SARA, expiresAt: null },
    ]);

    await expect(refusal(inReseller(() => h.service.addMembers(owner(), SUPPORT, { userIds: [REZA] })))).resolves.toEqual({
      reason: 'reseller_limit_reached',
      key: 'staff_members_max',
      limit: 2,
      used: 2,
    });
    expect(h.outbox).toEqual([]);
  });

  it('counts a person in two such groups once: adding Ali to Finance too is not one more', async () => {
    const h = harness(2, [
      { groupId: SUPPORT, userId: ALI, expiresAt: null },
      { groupId: FINANCE, userId: SARA, expiresAt: null },
    ]);

    await expect(inReseller(() => h.service.addMembers(owner(), FINANCE, { userIds: [ALI] }))).resolves.toEqual({ added: 1 });
  });

  it('does not count an ended membership', async () => {
    const h = harness(2, [
      { groupId: SUPPORT, userId: ALI, expiresAt: null },
      { groupId: FINANCE, userId: SARA, expiresAt: new Date(Date.now() - 60_000) },
    ]);

    await expect(inReseller(() => h.service.addMembers(owner(), SUPPORT, { userIds: [REZA] }))).resolves.toEqual({ added: 1 });
  });

  it('does not bound a group that gives no reseller key: a customer in "VIP" is not staff', async () => {
    const h = harness(2, [
      { groupId: SUPPORT, userId: ALI, expiresAt: null },
      { groupId: FINANCE, userId: SARA, expiresAt: null },
    ]);

    await expect(inReseller(() => h.service.addMembers(owner(), VIP, { userIds: [REZA] }))).resolves.toEqual({ added: 1 });
  });

  it('refuses putting a reseller key on a group whose members would take it past the limit', async () => {
    const h = harness(2, [
      { groupId: SUPPORT, userId: ALI, expiresAt: null },
      { groupId: VIP, userId: SARA, expiresAt: null },
      { groupId: VIP, userId: REZA, expiresAt: null },
    ]);

    await expect(refusal(inReseller(() => h.service.setAccess(owner(), VIP, { roleId: null, keys: ['user.read'] })))).resolves.toMatchObject({
      reason: 'reseller_limit_reached',
      used: 1,
      limit: 2,
    });
  });

  it("does not bound the platform's staff acting on a reseller", async () => {
    const h = harness(2, [
      { groupId: SUPPORT, userId: ALI, expiresAt: null },
      { groupId: FINANCE, userId: SARA, expiresAt: null },
    ]);

    await expect(inReseller(() => h.service.addMembers({ ...owner('staff'), adminId: 'staff-1' }, SUPPORT, { userIds: [REZA] }))).resolves.toEqual({ added: 1 });
  });
});
