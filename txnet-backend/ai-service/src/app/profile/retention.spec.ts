import type { PrismaService } from '../prisma/prisma.service';
import { ProfileBuilder } from './profile-builder.service';
import type { ProfileReader } from './profile-reader';
import { erasable, Retention } from './retention';

/**
 * F-038-s / ADR-0109 point 14: raw behaviour events live 180 days; an
 * account's events, profile, predictions and actions go with the account.
 *
 * The failures worth a spec: a deleted account's rows outliving it in any
 * table; a read that fails closed (the reader sees no account at all) taken
 * as "every account is gone" and erasing the tenant; a live account touched;
 * and the purge skipped for a tenant whose engine is off, so its readings
 * outlive 180 days because the engine stopped.
 */

const T0 = new Date('2026-10-03T12:00:00Z');
const TENANT = '00000000-0000-4000-8000-000000000001';
const LIVE = '00000000-0000-4000-8000-0000000000b1';
const DELETED = '00000000-0000-4000-8000-0000000000b2';
const GONE = '00000000-0000-4000-8000-0000000000b3';

describe('which subjects are erased (F-038-s)', () => {
  it('erases a soft-deleted account and keeps a live one', () => {
    const seen = [
      { id: LIVE, deletedAt: null },
      { id: DELETED, deletedAt: T0 },
    ];
    expect(erasable([LIVE, DELETED], seen, true)).toEqual([DELETED]);
  });

  it('erases an account identity no longer has, but only when the reader sees the tenant at all', () => {
    expect(erasable([LIVE, GONE], [{ id: LIVE, deletedAt: null }], true)).toEqual([GONE]);
    // A reader that sees nothing (FORCE RLS, a lost binding) proves nothing is gone.
    expect(erasable([LIVE, GONE], [], false)).toEqual([]);
  });
});

function fake(subjects: string[], seen: Array<{ id: string; deletedAt: Date | null }>, seesTenant = true) {
  const deleteMany = () => vi.fn(async () => ({ count: 1 }));
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => subjects.map((id) => ({ id }))),
    aiMeterReading: { deleteMany: vi.fn(async () => ({ count: 7 })) },
    aiAccountProfile: { deleteMany: deleteMany() },
    aiPrediction: { deleteMany: deleteMany() },
    aiAction: { deleteMany: deleteMany() },
    aiHoldout: { deleteMany: deleteMany() },
    aiOptOut: { deleteMany: deleteMany() },
    attentionBudget: { deleteMany: deleteMany() },
  };
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const reader = {
    accountStates: vi.fn(async (ids: string[]) => seen.filter((s) => ids.includes(s.id))),
    seesAnyAccount: vi.fn(async () => seesTenant),
  };
  return { retention: new Retention(prisma as unknown as PrismaService, reader as unknown as ProfileReader), tx, reader };
}

describe('the retention run (F-038-s)', () => {
  it('drops the tenant’s readings older than 180 days', async () => {
    const { retention, tx } = fake([], []);
    await expect(retention.runTenant(TENANT, T0)).resolves.toEqual({ purged: 7, erased: 0 });
    expect(tx.aiMeterReading.deleteMany).toHaveBeenCalledWith({ where: { tenantId: TENANT, hour: { lt: new Date('2026-04-06T12:00:00Z') } } });
  });

  it('erases a deleted account from every table that names it, and nothing of a live one', async () => {
    const { retention, tx } = fake([LIVE, DELETED], [{ id: LIVE, deletedAt: null }, { id: DELETED, deletedAt: T0 }]);
    await expect(retention.runTenant(TENANT, T0)).resolves.toEqual({ purged: 7, erased: 1 });

    const bySubject = { where: { tenantId: TENANT, subjectKind: 'user', subjectId: { in: [DELETED] } } };
    expect(tx.aiMeterReading.deleteMany).toHaveBeenCalledWith({ where: { tenantId: TENANT, userId: { in: [DELETED] } } });
    for (const table of [tx.aiAccountProfile, tx.aiPrediction, tx.aiAction, tx.aiHoldout, tx.aiOptOut, tx.attentionBudget]) {
      expect(table.deleteMany).toHaveBeenCalledWith(bySubject);
    }
  });

  it('erases nothing when every account is live', async () => {
    const { retention, tx } = fake([LIVE], [{ id: LIVE, deletedAt: null }]);
    await expect(retention.runTenant(TENANT, T0)).resolves.toEqual({ purged: 7, erased: 0 });
    expect(tx.aiAction.deleteMany).not.toHaveBeenCalled();
  });

  it('erases nothing when the reader sees no account of the tenant (fail closed)', async () => {
    const { retention, tx } = fake([LIVE, GONE], [], false);
    await expect(retention.runTenant(TENANT, T0)).resolves.toEqual({ purged: 7, erased: 0 });
    expect(tx.aiAction.deleteMany).not.toHaveBeenCalled();
  });
});

describe('retention runs for every tenant, engine on or off (F-038-s)', () => {
  it('purges a tenant whose engine does not run', async () => {
    const prisma = { tenant: { findMany: vi.fn(async () => [{ id: TENANT, tenantType: 'reseller' }]) } };
    const policy = { forTenant: vi.fn(async () => ({ engineRuns: false })) };
    const retention = { runTenant: vi.fn(async () => ({ purged: 3, erased: 2 })) };
    const builder = new ProfileBuilder(
      prisma as unknown as PrismaService,
      {} as ProfileReader,
      policy as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      retention as unknown as Retention,
    );
    const result = await builder.rebuildAll(T0);
    expect(retention.runTenant).toHaveBeenCalledWith(TENANT, T0);
    expect(result).toMatchObject({ skipped: 1, purged: 3, erased: 2 });
  });
});
