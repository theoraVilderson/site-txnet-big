/**
 * A membership's end is kept (GR-1-c, ADR-0139 (3)): when it passes, the
 * sweep removes the membership — which moves the person's token by trigger —
 * and tells them what they lost (`access.changed`, cause
 * `group_membership_ended`), against their access history.
 *
 * What would break silently here, and nowhere else:
 *  - an ended membership left in place for ever: `liveMembership` already
 *    gives it nothing, but the person was never told, and their open session
 *    kept its keys until the next token move;
 *  - a person told they lost a key they still hold through another group;
 *  - a membership still running swept early;
 *  - a second run (delivery is at-least-once) telling them twice.
 */
import { UserGroupMemberType } from '@prisma/client';

import { AccessReader } from '../../auth/permissions/access.reader';
import { MembershipEndSweep } from './membership-end.sweep';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SUPPORT = 'dddddddd-dddd-4ddd-8ddd-000000000001';
const DESK = 'dddddddd-dddd-4ddd-8ddd-000000000002';
const VIP = 'dddddddd-dddd-4ddd-8ddd-000000000003';
const LEAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALI = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const SARA = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const keys = (...k: string[]) => k.map((key) => ({ permission: { key } }));

type Row = { id: string; groupId: string; userId: string; expiresAt: Date | null };

function harness(rows: Row[]) {
  const members = [...rows];
  const groups: Record<string, { name: string; keys: string[] }> = {
    [SUPPORT]: { name: 'Support', keys: ['user.read', 'report.read'] },
    [DESK]: { name: 'Desk', keys: ['user.read'] },
    [VIP]: { name: 'VIP', keys: [] },
  };
  const outbox: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
  /** `liveMembership(at)`'s shape, read back: no end, or an end after `at`. */
  const liveAt = (where: { OR?: Array<{ expiresAt: null | { gt: Date } }> }) => {
    const gt = where.OR?.find((c) => c.expiresAt !== null)?.expiresAt as { gt: Date } | undefined;
    return (m: Row) => !gt || m.expiresAt === null || m.expiresAt > gt.gt;
  };
  const view = (m: Row) => ({
    ...m,
    tenantId: TENANT,
    memberType: UserGroupMemberType.user,
    memberTenantId: null,
    addedByAdminId: LEAD,
    group: { id: m.groupId, name: groups[m.groupId].name, allTenants: false, roleId: null, role: null, permissions: keys(...groups[m.groupId].keys) },
  });

  const db = {
    $executeRaw: vi.fn(async () => undefined),
    userGroupMember: {
      findMany: vi.fn(async ({ where, take }: { where: { expiresAt?: { lte: Date }; userId?: { in: string[] }; OR?: Array<{ expiresAt: null | { gt: Date } }>; group?: unknown }; take?: number }) => {
        let out = members;
        if (where.expiresAt) out = out.filter((m) => m.expiresAt !== null && m.expiresAt <= where.expiresAt!.lte);
        if (where.userId) out = out.filter((m) => where.userId!.in.includes(m.userId)).filter(liveAt(where));
        // The answer reads only groups that give access.
        if (where.group) out = out.filter((m) => groups[m.groupId].keys.length > 0);
        return out.slice(0, take ?? out.length).map(view);
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; expiresAt: { lte: Date } } }) => {
        const gone = members.filter((m) => where.id.in.includes(m.id) && m.expiresAt !== null && m.expiresAt <= where.expiresAt.lte);
        for (const m of gone) members.splice(members.indexOf(m), 1);
        return { count: gone.length };
      }),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, tenantId: TENANT, role: null }))),
    },
    userPermission: { findMany: vi.fn(async () => []) },
    outboxEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => void outbox.push(data)),
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => void outbox.push(...data)),
    },
    accessHistory: { createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => void history.push(...data)) },
  };
  const prisma = { ...db, $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(db)) };
  const sweep = new MembershipEndSweep(prisma as never, prisma as never, new AccessReader(prisma as never));
  return { sweep, members, outbox, history };
}

describe('a membership whose end has passed (GR-1-c)', () => {
  it('is removed, and the person is told what they lost, by the group, against their history', async () => {
    const h = harness([{ id: 'm-1', groupId: SUPPORT, userId: ALI, expiresAt: new Date(NOW.getTime() - HOUR) }]);

    await expect(h.sweep.endDue(NOW)).resolves.toEqual({ ended: 1, told: 1 });

    expect(h.members).toEqual([]);
    expect(h.outbox).toEqual([
      expect.objectContaining({ aggregateId: ALI, payload: { userId: ALI, tenantId: TENANT, cause: 'group_membership_ended', group: 'Support', given: [], taken: ['report.read', 'user.read'] } }),
    ]);
    // Who set the end is who added them with it; no act of anyone's at the moment it passed.
    expect(h.history).toEqual([expect.objectContaining({ userId: ALI, cause: 'group_membership_ended', actorUserId: LEAD, auditLogId: null, taken: ['report.read', 'user.read'] })]);
  });

  it('tells only what was lost: a key still held through another group is not', async () => {
    const h = harness([
      { id: 'm-1', groupId: SUPPORT, userId: ALI, expiresAt: new Date(NOW.getTime() - HOUR) },
      { id: 'm-2', groupId: DESK, userId: ALI, expiresAt: null },
    ]);

    await h.sweep.endDue(NOW);

    expect(h.outbox[0]).toMatchObject({ payload: { taken: ['report.read'] } });
  });

  it('tells no one whose answer did not move, and still removes the membership', async () => {
    const h = harness([
      { id: 'm-1', groupId: DESK, userId: ALI, expiresAt: new Date(NOW.getTime() - HOUR) },
      { id: 'm-2', groupId: SUPPORT, userId: ALI, expiresAt: null },
      { id: 'm-3', groupId: VIP, userId: SARA, expiresAt: new Date(NOW.getTime() - HOUR) },
    ]);

    await expect(h.sweep.endDue(NOW)).resolves.toEqual({ ended: 2, told: 0 });

    expect(h.members.map((m) => m.id)).toEqual(['m-2']);
    expect(h.outbox).toEqual([]);
    expect(h.history).toEqual([]);
  });

  it('leaves a membership that has not ended, and one with no end', async () => {
    const h = harness([
      { id: 'm-1', groupId: SUPPORT, userId: ALI, expiresAt: new Date(NOW.getTime() + HOUR) },
      { id: 'm-2', groupId: SUPPORT, userId: SARA, expiresAt: null },
    ]);

    await expect(h.sweep.endDue(NOW)).resolves.toEqual({ ended: 0, told: 0 });
    expect(h.members).toHaveLength(2);
  });

  it('tells once: a second run finds nothing', async () => {
    const h = harness([{ id: 'm-1', groupId: SUPPORT, userId: ALI, expiresAt: new Date(NOW.getTime() - HOUR) }]);

    await h.sweep.endDue(NOW);
    await expect(h.sweep.endDue(NOW)).resolves.toEqual({ ended: 0, told: 0 });
    expect(h.outbox).toHaveLength(1);
  });
});
