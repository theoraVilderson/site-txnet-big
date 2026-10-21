import { GrantSource, GrantStatus, MigrationItemAction, MigrationItemOutcome, MigrationRunStatus, Prisma, QuotaMetric } from '@prisma/client';
import { OutboxEventType, runWithTenant } from '@txnet-backend/shared-core';

import type { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RemainderCreditService } from '../traffic/remainder-credit';
import type { UsageSettlementService } from '../usage/usage-settlement';
import { deleteGrant } from './delete';
import { EntitlementRefused } from './grant';
import { MIGRATION_ROLLED_BACK, MigrationRollbackService } from './migration-rollback';
import { MigrationRunService } from './migration-run';
import { MigrationSeamUnavailable, type ImportedPeople } from './migration-seams';

vi.mock('./delete', async (actual) => ({ ...(await actual<typeof import('./delete')>()), deleteGrant: vi.fn(async () => ({})) }));

/**
 * F-211 (D-63): a committed import rolled back inside its 7 days. What fails
 * silently here: a customer who renewed, topped up or bought since loses the
 * service they paid for here; a person the run did not make — or one who
 * holds something else now — is removed; a Grant is closed twice when a tick
 * is retried; a person left behind because identity was down that tick; and
 * a source snapshot that outlives the window it was kept for.
 */
const NOW = new Date('2026-10-24T12:00:00Z');
const IMPORTED = new Date('2026-10-21T12:00:00Z');
const RUN = {
  id: '00000000-0000-4000-8000-000000000211',
  tenantId: '00000000-0000-4000-8000-0000000000aa',
  actorUserId: '00000000-0000-4000-8000-0000000000bb',
  rollbackActorUserId: '00000000-0000-4000-8000-0000000000cc',
  status: MigrationRunStatus.rolling_back,
  workerClaimedAt: null,
  rollbackUntil: new Date('2026-10-28T12:00:00Z'),
  snapshotsPurgedAt: null,
};

type Row = Record<string, unknown>;

/** A committed item: the run made its Grant and, unless `found`, its person. */
const item = (name: string, over: Row = {}): Row => ({
  id: `item-${name}`,
  runId: RUN.id,
  tenantId: RUN.tenantId,
  remoteIdentity: `marzban|https://old.example|${name}`,
  sourceSnapshot: { remoteId: name },
  plannedAction: MigrationItemAction.create,
  outcome: MigrationItemOutcome.created,
  keptReason: null,
  rolledBackAt: null,
  createdUserId: `user-${name}`,
  createdGrantId: `grant-${name}`,
  createdAt: new Date(IMPORTED.getTime() + name.length),
  ...over,
});

const grant = (name: string, over: Row = {}): Row => ({
  id: `grant-${name}`,
  userId: `user-${name}`,
  status: GrantStatus.active,
  source: GrantSource.migration,
  startsAt: IMPORTED,
  endSetAt: IMPORTED,
  createdAt: IMPORTED,
  ...over,
});

type Facts = { renewals?: string[]; topUps?: string[]; wallets?: Row[]; walletTx?: Row[] };

const inList = (v: unknown, where: unknown) => (where && typeof where === 'object' ? !('in' in where) || (where as { in: unknown[] }).in.includes(v) : where === undefined || v === where);
const notIn = (v: unknown, where: unknown) => !(where && typeof where === 'object' && 'notIn' in where) || !(where as { notIn: unknown[] }).notIn.includes(v);
const after = (v: unknown, where: unknown) => !(where && typeof where === 'object' && 'gt' in where) || (v as Date).getTime() > ((where as { gt: Date }).gt as Date).getTime();

/** The run, its items, the Grants and the billing facts the rollback reads, in memory. */
function fakeDb(items: Row[], grants: Row[], facts: Facts = {}, run: Row = {}) {
  const state = { run: { ...RUN, ...run } as Row, items, grants, outbox: [] as Row[], oldLinks: [] as string[] };
  const itemMatches = (i: Row, where: Row): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as Row[]).some((w) => itemMatches(i, w));
      if (v && typeof v === 'object' && 'not' in v) return i[k] !== (v as { not: unknown }).not;
      return i[k] === v;
    });
  const grantMatches = (g: Row, where: Row) =>
    inList(g['id'], where['id']) && notIn(g['id'], where['id']) && inList(g['userId'], where['userId']) && inList(g['source'], where['source']);
  const maxOf = (rows: Row[], key: string) => {
    const by = new Map<string, Date>();
    for (const r of rows) {
      const at = r['createdAt'] as Date;
      const k = String(r[key]);
      if (!by.has(k) || (by.get(k) as Date) < at) by.set(k, at);
    }
    return [...by].map(([k, at]) => ({ [key]: k, _max: { createdAt: at }, _count: { _all: rows.filter((r) => String(r[key]) === k).length } }));
  };
  const models: Record<string, Row> = {
    migrationRun: {
      findFirst: async () => ({ ...state.run }),
      findMany: async () => [{ ...state.run }],
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = Object.entries(where).every(([k, v]) => k === 'OR' || typeof v === 'object' || state.run[k] === v);
        if (!hit) return { count: 0 };
        Object.assign(state.run, data);
        return { count: 1 };
      },
    },
    migrationItem: {
      findMany: async ({ where, take }: { where: Row; take: number }) => state.items.filter((i) => itemMatches(i, where)).slice(0, take),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = state.items.filter((i) => itemMatches(i, where));
        hit.forEach((i) => Object.assign(i, data));
        return { count: hit.length };
      },
    },
    grant: {
      findMany: async ({ where }: { where: Row }) => state.grants.filter((g) => grantMatches(g, where)),
      groupBy: async ({ where }: { where: Row }) => maxOf(state.grants.filter((g) => grantMatches(g, where) && after(g['createdAt'], where['createdAt'])), 'userId'),
    },
    grantRenewal: { findMany: async () => (facts.renewals ?? []).map((grantId) => ({ grantId })) },
    quotaAdjustment: {
      findMany: async ({ where }: { where: Row }) => {
        expect(where['metric']).toBe(QuotaMetric.traffic_bytes);
        return (facts.topUps ?? []).map((grantId) => ({ grantId }));
      },
    },
    wallet: { findMany: async ({ where }: { where: Row }) => (facts.wallets ?? []).filter((w) => inList(w['ownerUserId'], where['ownerUserId'])) },
    walletTransaction: { groupBy: async ({ where }: { where: Row }) => maxOf((facts.walletTx ?? []).filter((t) => inList(t['walletId'], where['walletId'])), 'walletId') },
    outboxEvent: { create: async ({ data }: { data: Row }) => state.outbox.push(data) },
    legacySubLink: { deleteMany: async ({ where }: { where: Row }) => ({ count: state.oldLinks.push(String(where['grantId'])) }) },
  };
  const tx = new Proxy(models, { get: (target, name: string) => (name === '$executeRaw' ? async () => 0 : target[name]) });
  const prisma = { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as unknown as PrismaService;
  return { state, prisma, crossTenant: tx as unknown as CrossTenantPrismaService };
}

type Removal = { removed: string[]; kept: { userId: string; reason: string }[] };

function rollback(db: ReturnType<typeof fakeDb>, answer?: (userIds: string[]) => Promise<Removal>) {
  const remove = vi.fn((_tenantId: string, userIds: string[]) => (answer ? answer(userIds) : Promise.resolve({ removed: userIds, kept: [] })));
  const settleAtClose = vi.fn(async () => undefined);
  const wholesaleAtClose = vi.fn(async () => undefined);
  const service = new MigrationRollbackService(
    db.prisma,
    db.crossTenant,
    { remove } as unknown as ImportedPeople,
    { wholesaleAtClose, settle: vi.fn() } as unknown as RemainderCreditService,
    { settleAtClose } as unknown as UsageSettlementService,
  );
  return { run: () => service.rollbackNext(NOW), purge: () => service.purgeEnded(NOW), remove, settleAtClose, wholesaleAtClose };
}

const byName = (db: ReturnType<typeof fakeDb>, name: string) => db.state.items.find((i) => i['id'] === `item-${name}`) as Row;
const closed = () => vi.mocked(deleteGrant).mock.calls.map((c) => c[1]);

describe('MigrationRollbackService (F-211)', () => {
  beforeEach(() => vi.mocked(deleteGrant).mockClear());

  it('closes an untouched Grant as an admin delete with no refund, and removes the person the run made', async () => {
    const db = fakeDb([item('ali')], [grant('ali')]);
    const r = rollback(db);

    expect(await r.run()).toEqual({ outcome: 'batch', items: 1 });

    expect(vi.mocked(deleteGrant)).toHaveBeenCalledWith(
      expect.anything(),
      'grant-ali',
      { at: NOW, actorUserId: RUN.rollbackActorUserId, reason: MIGRATION_ROLLED_BACK, refund: false, statusReason: MIGRATION_ROLLED_BACK },
      expect.any(Function),
    );
    // The reseller's wholesale comes back and every other meter settles, as an admin delete answering no.
    expect(r.settleAtClose).toHaveBeenCalledWith(expect.anything(), { grantId: 'grant-ali', refund: false });
    expect(r.wholesaleAtClose).toHaveBeenCalledWith(expect.anything(), 'grant-ali');
    // F-203-a: the old link stops answering with the Grant it led to.
    expect(db.state.oldLinks).toEqual(['grant-ali']);
    expect(r.remove).toHaveBeenCalledWith(RUN.tenantId, ['user-ali']);
    expect(byName(db, 'ali')).toMatchObject({ outcome: MigrationItemOutcome.rolled_back, rolledBackAt: NOW, keptReason: null });
    expect(db.state.outbox).toEqual([expect.objectContaining({ type: OutboxEventType.MIGRATION_RUN_PROGRESS, aggregateId: RUN.id })]);
  });

  it('keeps a customer who renewed, topped up or bought since, and says why', async () => {
    const db = fakeDb(
      [item('renewed'), item('admindays'), item('topped'), item('bought'), item('paid')],
      [
        grant('renewed'),
        // An end moved since the import is a renewal, whichever path moved it.
        grant('admindays', { endSetAt: new Date('2026-10-22T09:00:00Z') }),
        grant('topped'),
        grant('bought'),
        grant('other-of-bought', { userId: 'user-bought', source: GrantSource.purchase, createdAt: new Date('2026-10-23T09:00:00Z') }),
        grant('paid'),
      ],
      {
        renewals: ['grant-renewed'],
        topUps: ['grant-topped'],
        wallets: [{ id: 'wallet-paid', ownerUserId: 'user-paid' }],
        walletTx: [{ walletId: 'wallet-paid', createdAt: new Date('2026-10-22T10:00:00Z') }],
      },
    );
    const r = rollback(db);

    await r.run();

    expect(closed()).toEqual([]);
    expect(r.remove).not.toHaveBeenCalled();
    expect(['renewed', 'admindays', 'topped', 'bought', 'paid'].map((n) => byName(db, n)['keptReason'])).toEqual(['renewed', 'renewed', 'topped_up', 'bought', 'bought']);
    for (const n of ['renewed', 'admindays', 'topped', 'bought', 'paid']) expect(byName(db, n)).toMatchObject({ outcome: MigrationItemOutcome.kept, rolledBackAt: NOW });
  });

  it('does not count what the person bought before the import', async () => {
    const before = new Date('2026-10-01T00:00:00Z');
    const db = fakeDb(
      [item('old', { createdUserId: null })],
      [grant('old'), grant('earlier', { userId: 'user-old', source: GrantSource.purchase, createdAt: before })],
      { wallets: [{ id: 'wallet-old', ownerUserId: 'user-old' }], walletTx: [{ walletId: 'wallet-old', createdAt: before }] },
    );

    await rollback(db).run();

    expect(closed()).toEqual(['grant-old']);
    expect(byName(db, 'old')).toMatchObject({ outcome: MigrationItemOutcome.rolled_back, rolledBackAt: NOW });
  });

  it('removes only people the run made who hold nothing else, and lists why one stays', async () => {
    const db = fakeDb(
      [item('found', { createdUserId: null }), item('trial'), item('signed'), item('fresh')],
      [grant('found', { userId: 'user-found' }), grant('trial'), grant('a-trial', { userId: 'user-trial', source: GrantSource.trial }), grant('signed'), grant('fresh')],
    );
    const r = rollback(db, async (userIds) => ({ removed: userIds.filter((u) => u !== 'user-signed'), kept: [{ userId: 'user-signed', reason: 'signed_in' }] }));

    await r.run();

    // A person found, not made, is never asked about; one holding another service is not either.
    expect(r.remove).toHaveBeenCalledWith(RUN.tenantId, ['user-signed', 'user-fresh']);
    expect(closed()).toEqual(['grant-found', 'grant-trial', 'grant-signed', 'grant-fresh']);
    expect(byName(db, 'trial')).toMatchObject({ outcome: MigrationItemOutcome.rolled_back, keptReason: 'holds_other_service', rolledBackAt: NOW });
    expect(byName(db, 'signed')).toMatchObject({ outcome: MigrationItemOutcome.rolled_back, keptReason: 'signed_in', rolledBackAt: NOW });
    expect(byName(db, 'fresh')).toMatchObject({ outcome: MigrationItemOutcome.rolled_back, keptReason: null, rolledBackAt: NOW });
  });

  it('a person the commit made though its Grant failed is still removed', async () => {
    const db = fakeDb([item('failed', { outcome: MigrationItemOutcome.failed, createdGrantId: null })], []);
    const r = rollback(db);

    await r.run();

    expect(closed()).toEqual([]);
    expect(r.remove).toHaveBeenCalledWith(RUN.tenantId, ['user-failed']);
    expect(byName(db, 'failed')).toMatchObject({ outcome: MigrationItemOutcome.failed, rolledBackAt: NOW });
  });

  it('identity down: the Grant stays closed once, and the next tick removes the person', async () => {
    const db = fakeDb([item('ali')], [grant('ali')]);
    let down = true;
    const r = rollback(db, async (userIds) => {
      if (down) throw new MigrationSeamUnavailable('auth-service did not answer');
      return { removed: userIds, kept: [] };
    });

    expect(await r.run()).toEqual({ outcome: 'waiting', items: 1 });
    expect(byName(db, 'ali')).toMatchObject({ outcome: MigrationItemOutcome.rolled_back, rolledBackAt: null });

    down = false;
    db.state.grants[0] = { ...db.state.grants[0], status: GrantStatus.cancelled };
    await r.run();

    expect(closed()).toEqual(['grant-ali']);
    expect(r.remove).toHaveBeenCalledTimes(2);
    expect(byName(db, 'ali')['rolledBackAt']).toEqual(NOW);
  });

  it('a Grant already closed is not closed again; one that cannot be closed is kept and listed', async () => {
    vi.mocked(deleteGrant).mockImplementation(async (_tx, grantId) => {
      if (grantId === 'grant-pending') throw new EntitlementRefused('grant_not_active', 'pending');
      return {} as Awaited<ReturnType<typeof deleteGrant>>;
    });
    const db = fakeDb(
      [item('gone', { createdUserId: null }), item('pending', { createdUserId: null })],
      [grant('gone', { status: GrantStatus.expired }), grant('pending', { status: GrantStatus.pending })],
    );

    await rollback(db).run();

    expect(byName(db, 'gone')).toMatchObject({ outcome: MigrationItemOutcome.rolled_back, rolledBackAt: NOW });
    expect(byName(db, 'pending')).toMatchObject({ outcome: MigrationItemOutcome.kept, keptReason: 'grant_not_active', rolledBackAt: NOW });
    vi.mocked(deleteGrant).mockImplementation(async () => ({}) as Awaited<ReturnType<typeof deleteGrant>>);
  });

  it('leaves an item a run kept from an earlier one, and ends the run when nothing is left', async () => {
    const kept = item('earlier', { outcome: MigrationItemOutcome.updated, createdUserId: null, createdGrantId: null });
    const db = fakeDb([kept, item('done', { outcome: MigrationItemOutcome.rolled_back, rolledBackAt: NOW })], []);
    const r = rollback(db);

    expect(await r.run()).toEqual({ outcome: 'finished', items: 0 });

    expect(closed()).toEqual([]);
    expect(kept['outcome']).toBe(MigrationItemOutcome.updated);
    expect(db.state.run).toMatchObject({ status: MigrationRunStatus.rolled_back, workerClaimedAt: null });
    expect(db.state.outbox).toHaveLength(1);
  });

  it('purges the snapshots of a run whose window ended', async () => {
    const db = fakeDb([item('ali')], [], {}, { status: MigrationRunStatus.committed, rollbackUntil: new Date('2026-10-24T11:00:00Z') });

    expect(await rollback(db).purge()).toBe(1);

    expect(byName(db, 'ali')['sourceSnapshot']).toBe(Prisma.DbNull);
    expect(db.state.run['snapshotsPurgedAt']).toEqual(NOW);
  });
});

describe('MigrationRunService.rollback (F-211)', () => {
  const ACTOR = { userId: RUN.rollbackActorUserId } as never;
  const asked = (run: Row, now = NOW) => {
    const db = fakeDb([], [], {}, run);
    const models = db.crossTenant as unknown as Record<string, Row>;
    models['migrationRun']['update'] = async ({ data }: { data: Row }) => Object.assign(db.state.run, data);
    models['migrationInbound'] = { findMany: async () => [] };
    // The door runs the work in the reseller's tenant, as `ResellerAccess` does.
    const access = { for: () => ({ run: (_a: unknown, tenantId: string, _c: unknown, work: () => unknown) => runWithTenant({ id: tenantId }, work) }) };
    const service = new MigrationRunService(db.prisma, access as never, {} as never);
    return { db, act: () => service.rollback(ACTOR, RUN.tenantId, RUN.id, now) };
  };
  const reason = (p: Promise<unknown>) => p.then(() => null, (e: { reason?: string }) => e.reason);

  it('moves a committed run inside its window to rolling_back, naming who asked', async () => {
    const { db, act } = asked({ status: MigrationRunStatus.committed, rollbackActorUserId: null });
    expect(await act()).toMatchObject({ status: MigrationRunStatus.rolling_back });
    expect(db.state.run).toMatchObject({ status: MigrationRunStatus.rolling_back, rollbackActorUserId: RUN.rollbackActorUserId, workerClaimedAt: null });
    expect(db.state.outbox).toHaveLength(1);
  });

  it('refuses a run never committed, one past its window, and one cancelled; answers one already rolling back', async () => {
    expect(await reason(asked({ status: MigrationRunStatus.previewed, rollbackUntil: null }).act())).toBe('run_not_committed');
    expect(await reason(asked({ status: MigrationRunStatus.committed, rollbackUntil: new Date('2026-10-24T11:59:59Z') }).act())).toBe('rollback_window_closed');
    expect(await reason(asked({ status: MigrationRunStatus.cancelled, rollbackUntil: null }).act())).toBe('run_closed');
    const again = asked({ status: MigrationRunStatus.rolling_back });
    expect(await again.act()).toMatchObject({ status: MigrationRunStatus.rolling_back });
    expect(again.db.state.outbox).toHaveLength(0);
  });
});
