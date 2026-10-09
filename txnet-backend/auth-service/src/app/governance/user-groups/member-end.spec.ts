/**
 * A membership may end (ADR-0139 (3)), and the end is set where a member is
 * managed (GR-1-d): when they are added, and moved or cleared in place later.
 *
 * What would break silently here, and nowhere else:
 *  - an end in the past written as if it were a policy: the person would hold
 *    nothing from the moment they were "added";
 *  - an end moved with no trail, or moved by someone with no authority over
 *    the person — moving an ended membership's end gives its access back, so
 *    it is a grant like joining;
 *  - a member page that hides when each membership ends.
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

const DAY = 24 * 60 * 60 * 1000;
const keys = (...k: string[]) => k.map((key) => ({ permission: { key } }));

type Row = { userId: string; expiresAt: Date | null; createdAt: Date };

function harness(start: Row[] = [], groupKeys: string[] = ['coupon.manage']) {
  const members: Row[] = [...start];
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
      findMany: vi.fn(async ({ where, distinct }: { where: { groupId?: string; userId?: { in: string[] } }; distinct?: string[] }) => {
        if (distinct) return [];
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
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { expiresAt: Date | null } }) => {
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
  return { service, members, audits, outbox };
}

const lead = (permissions: string[] = ['user_group.manage', 'coupon.manage', 'user.read', 'report.read']) => ({ adminId: LEAD, tenantId: TENANT, ip: '1.1.1.1', permissions });
const inTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);
const reason = (p: Promise<unknown>) => p.then(() => 'none', (e) => (e instanceof UserGroupRefused ? e.reason : String(e)));

describe("a membership's end (GR-1-d, ADR-0139 (3))", () => {
  it('is set when a member is added, and shown on the member page', async () => {
    const h = harness();
    const end = new Date(Date.now() + 30 * DAY);
    await inTenant(() => h.service.addMembers(lead(), GROUP, { userIds: [ALI], expiresAt: end }));

    expect(h.members).toEqual([expect.objectContaining({ userId: ALI, expiresAt: end })]);
    const page = await inTenant(() => h.service.members(lead(), GROUP, 1, 50));
    expect(page.items[0]).toMatchObject({ userId: ALI, expiresAt: end });
  });

  it('refuses an end already past, on add and on a move', async () => {
    const h = harness([{ userId: ALI, expiresAt: null, createdAt: new Date() }]);
    const past = new Date(Date.now() - DAY);

    await expect(reason(inTenant(() => h.service.addMembers(lead(), GROUP, { userIds: [SARA], expiresAt: past })))).resolves.toBe('expiry_past');
    await expect(reason(inTenant(() => h.service.setMemberEnd(lead(), GROUP, ALI, past)))).resolves.toBe('expiry_past');
    expect(h.members).toHaveLength(1);
  });

  it('is moved or cleared in place, audited with before and after; a live member is told nothing', async () => {
    const was = new Date(Date.now() + DAY);
    const h = harness([{ userId: ALI, expiresAt: was, createdAt: new Date() }]);

    const view = await inTenant(() => h.service.setMemberEnd(lead(), GROUP, ALI, null));

    expect(view).toEqual({ userId: ALI, expiresAt: null });
    expect(h.members[0].expiresAt).toBeNull();
    expect(h.audits).toEqual([expect.objectContaining({ action: 'user_group_member_end_set', oldValue: { userId: ALI, expiresAt: was.toISOString() }, newValue: { userId: ALI, expiresAt: null } })]);
    expect(h.outbox).toEqual([]);
  });

  it('gives an ended membership its access back when moved later, and tells them — a grant like joining', async () => {
    const h = harness([{ userId: ALI, expiresAt: new Date(Date.now() - 60_000), createdAt: new Date() }]);

    await inTenant(() => h.service.setMemberEnd(lead(), GROUP, ALI, new Date(Date.now() + DAY)));

    expect(h.outbox[0]).toMatchObject({ aggregateId: ALI, payload: { cause: 'group_access', given: ['coupon.manage'] } });
  });

  it('refuses a move by someone who does not hold what the group gives', async () => {
    const h = harness([{ userId: ALI, expiresAt: null, createdAt: new Date() }]);
    await expect(reason(inTenant(() => h.service.setMemberEnd(lead(['user_group.manage']), GROUP, ALI, null)))).resolves.toBe('key_not_held');
  });

  it('answers member_not_found for someone not in the group', async () => {
    const h = harness();
    await expect(reason(inTenant(() => h.service.setMemberEnd(lead(), GROUP, SARA, null)))).resolves.toBe('member_not_found');
  });
});
