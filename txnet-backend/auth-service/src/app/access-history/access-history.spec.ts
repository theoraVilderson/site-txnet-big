import { recordAccessChange, runWithTenant } from '@txnet-backend/shared-core';
import { describe, expect, it, vi } from 'vitest';

import { AccessHistoryRefused, AccessHistoryService } from './access-history.service';

/**
 * AC-1-p: who gave whom what is answerable without the database. One history
 * row per person an act moved, written with the act; a person's list is those
 * rows joined to the act (who, before, after, reason); the tenant's log is the
 * acts, each with how many people it moved.
 */

const T = 'tenant-reseller';
const ALI = 'user-ali';
const BOSS = 'user-boss';
const GROUP = 'group-support';
const ROLE = 'role-operator';

function recorder() {
  const tx = {
    accessHistory: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    outboxEvent: { create: vi.fn().mockResolvedValue({ id: 'e' }), createMany: vi.fn().mockResolvedValue({ count: 2 }) },
  };
  return tx;
}

describe('recordAccessChange', () => {
  it('writes the history row and the event a told cause owes, in one call', async () => {
    const tx = recorder();
    await recordAccessChange(tx as never, [
      { userId: ALI, tenantId: T, cause: 'keys_set', actorUserId: BOSS, auditLogId: 'a-1', detail: { given: ['wallet.manual_adjust'], taken: [] } },
    ]);
    expect(tx.accessHistory.createMany).toHaveBeenCalledWith({
      data: [{ tenantId: T, userId: ALI, actorUserId: BOSS, cause: 'keys_set', auditLogId: 'a-1', given: ['wallet.manual_adjust'], taken: [] }],
    });
    expect(tx.outboxEvent.create.mock.calls[0][0].data.payload).toEqual({ userId: ALI, tenantId: T, cause: 'keys_set', given: ['wallet.manual_adjust'], taken: [] });
  });

  it('remembers a seat invite without telling anyone: there is no notice for it', async () => {
    const tx = recorder();
    await recordAccessChange(tx as never, [{ userId: ALI, tenantId: T, cause: 'seat_invited', actorUserId: BOSS, auditLogId: 'a-2' }]);
    expect(tx.accessHistory.createMany).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.createMany).not.toHaveBeenCalled();
  });

  it('a role edit reaching two people is two rows and two events, both pointing at the one act', async () => {
    const tx = recorder();
    const one = (userId: string) => ({ userId, tenantId: T, cause: 'role_edited' as const, actorUserId: BOSS, auditLogId: 'a-3', detail: { given: [], taken: ['grant.assign'] } });
    await recordAccessChange(tx as never, [one(ALI), one('user-sara')]);
    expect(tx.accessHistory.createMany.mock.calls[0][0].data.map((r: { auditLogId: string }) => r.auditLogId)).toEqual(['a-3', 'a-3']);
    expect(tx.outboxEvent.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it('writes nothing for nobody', async () => {
    const tx = recorder();
    await recordAccessChange(tx as never, []);
    expect(tx.accessHistory.createMany).not.toHaveBeenCalled();
  });
});

const at = (min: number) => new Date(Date.UTC(2026, 9, 9, 10, min));

/** Ali joined the support group (a-1), the group was given a key (a-2), and Ali was given one directly (a-3). */
const HISTORY = [
  { id: 'h-3', tenantId: T, userId: ALI, actorUserId: BOSS, cause: 'keys_set', auditLogId: 'a-3', given: ['audit.read'], taken: [], createdAt: at(3) },
  { id: 'h-2', tenantId: T, userId: ALI, actorUserId: BOSS, cause: 'group_access', auditLogId: 'a-2', given: ['wallet.manual_adjust'], taken: [], createdAt: at(2) },
  { id: 'h-1', tenantId: T, userId: ALI, actorUserId: ALI, cause: 'seat_joined', auditLogId: null, given: [], taken: [], createdAt: at(1) },
];
const ACTS = [
  { id: 'a-3', tenantId: T, adminId: BOSS, action: 'user_permission_set', targetEntityType: 'user', targetEntityId: ALI, oldValue: null, newValue: { key: 'audit.read', effect: 'give', reason: 'runs the monthly review' }, reason: null, createdAt: at(3) },
  { id: 'a-2', tenantId: T, adminId: BOSS, action: 'user_group_access_set', targetEntityType: 'user_group', targetEntityId: GROUP, oldValue: { roleId: null, keys: [] }, newValue: { roleId: ROLE, keys: ['wallet.manual_adjust'] }, reason: null, createdAt: at(2) },
  { id: 'a-4', tenantId: T, adminId: BOSS, action: 'role_keys_set', targetEntityType: 'role', targetEntityId: ROLE, oldValue: { keys: ['grant.assign'] }, newValue: { keys: [] }, reason: null, createdAt: at(4) },
];

function reader(opts: { person?: boolean } = {}) {
  const keys: string[][] = [];
  const access = {
    for: (...k: string[]) => {
      keys.push(k);
      return { runIncludingPlatform: (_a: unknown, tenantId: string, _c: string, work: (r: unknown) => unknown) => work({ id: tenantId, as: 'owner' }) };
    },
  };
  const models = {
    user: { findFirst: vi.fn().mockResolvedValue(opts.person === false ? null : { id: ALI }) },
    accessHistory: {
      findMany: vi.fn().mockResolvedValue(HISTORY),
      groupBy: vi.fn().mockResolvedValue([{ auditLogId: 'a-4', _count: { _all: 2 } }, { auditLogId: 'a-2', _count: { _all: 1 } }]),
    },
    adminAuditLog: {
      findMany: vi.fn().mockImplementation(({ where }: { where: { id?: { in: string[] } } }) =>
        Promise.resolve(where.id ? ACTS.filter((a) => where.id!.in.includes(a.id)) : [ACTS[2], ACTS[0], ACTS[1]]),
      ),
    },
    userGroup: { findMany: vi.fn().mockResolvedValue([{ id: GROUP, name: 'Support' }]) },
    role: { findMany: vi.fn().mockResolvedValue([{ id: ROLE, name: 'Operator' }]) },
  };
  const tx = { ...models, $executeRaw: vi.fn().mockResolvedValue(1) };
  const prisma = { ...models, $transaction: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)) };
  // Names are read across tenants: a reseller's owner is a user of the platform's tenant (ADR-0059).
  const all = { user: { findMany: vi.fn().mockResolvedValue([{ id: BOSS, fullName: 'Boss', username: 'boss' }, { id: ALI, fullName: 'Ali', username: null }]) } };
  const service = new AccessHistoryService(prisma as never, all as never, access as never);
  const inTenant = <R>(work: () => Promise<R>) => runWithTenant({ id: T }, work);
  return { service, models, keys, inTenant };
}

const ACTOR = { userId: BOSS, tenantId: 'tenant-platform', permissions: [] };

describe('AccessHistoryService.ofPerson', () => {
  it("answers the person's rows newest first, each with who, what, before, after and why", async () => {
    const { service, inTenant } = reader();
    const out = await inTenant(() => service.ofPerson(ACTOR, T, ALI, 1));
    expect(out.items.map((i) => i.cause)).toEqual(['keys_set', 'group_access', 'seat_joined']);
    expect(out.items[0]).toMatchObject({
      actor: { id: BOSS, name: 'Boss' },
      given: ['audit.read'],
      act: { action: 'user_permission_set', target: { type: 'user', id: ALI }, after: { key: 'audit.read', effect: 'give' }, reason: 'runs the monthly review' },
    });
    // A key reached through a group names the group, and the role it gives, by name.
    expect(out.items[1].act).toMatchObject({ target: { type: 'user_group', id: GROUP, name: 'Support' }, after: { roleId: ROLE, roleName: 'Operator' } });
    // The person's own act has no audit row, and says so.
    expect(out.items[2]).toMatchObject({ actor: { id: ALI, name: 'Ali' }, act: null });
  });

  it('is read by whoever reads their keys, or by an auditor', async () => {
    const { service, keys, inTenant } = reader();
    await inTenant(() => service.ofPerson(ACTOR, T, ALI, 1));
    expect(keys).toEqual([['role.manage', 'audit.read']]);
  });

  it('refuses someone who is not this tenant\'s person', async () => {
    const { service, inTenant } = reader({ person: false });
    await expect(inTenant(() => service.ofPerson(ACTOR, T, 'user-elsewhere', 1))).rejects.toEqual(new AccessHistoryRefused('user_not_found', 'user-elsewhere'));
  });
});

describe('AccessHistoryService.ofTenant', () => {
  it('lists the access acts only, each with how many people it moved', async () => {
    const { service, models, keys, inTenant } = reader();
    const out = await inTenant(() => service.ofTenant(ACTOR, T, 1));
    expect(keys).toEqual([['audit.read']]);
    const where = models.adminAuditLog.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(T);
    expect(where.action.in).toEqual(expect.arrayContaining(['role_change', 'user_permission_set', 'user_group_access_set', 'role_keys_set', 'staff_seat_remove']));
    expect(where.action.in).not.toContain('grant_freeze');
    expect(out.items.map((i) => [i.action, i.moved])).toEqual([
      ['role_keys_set', 2],
      ['user_permission_set', 0],
      ['user_group_access_set', 1],
    ]);
    expect(out.items[0]).toMatchObject({ actor: { name: 'Boss' }, target: { type: 'role', name: 'Operator' }, before: { keys: ['grant.assign'] } });
  });

  it('names a deleted group by the name its delete row kept', async () => {
    const { service, models, inTenant } = reader();
    models.adminAuditLog.findMany.mockResolvedValueOnce([
      { ...ACTS[1], id: 'a-9', action: 'user_group_delete', targetEntityId: 'group-gone', oldValue: { name: 'Night desk' }, newValue: null },
    ]);
    const out = await inTenant(() => service.ofTenant(ACTOR, T, 1));
    expect(out.items[0].target).toEqual({ type: 'user_group', id: 'group-gone', name: 'Night desk' });
  });
});
