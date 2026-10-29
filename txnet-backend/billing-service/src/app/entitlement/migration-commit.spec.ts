import { DriverType, FreezeMode, GrantSource, MigrationItemAction, MigrationItemOutcome, MigrationRunKind, MigrationRunStatus, Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import type { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ConfigActionsService } from '../traffic/config-actions';
import type { GroupFulfilmentService } from '../traffic/group-fulfilment';
import { freezeGrant } from './freeze';
import { EntitlementRefused, type GrantService } from './grant';
import { linkClientOf, linkIdentityOf } from './migration-link';
import { importedGrantShape } from './migration-plan';
import { MIGRATION_COMMIT_BATCH_SIZE, MigrationCommitService } from './migration-commit';
import { MIGRATION_ROLLBACK_DAYS } from './migration-run';
import { MigrationSeamUnavailable, type ImportedPeople, type SourceLoginVault } from './migration-seams';

vi.mock('./freeze', async (actual) => ({ ...(await actual<typeof import('./freeze')>()), freezeGrant: vi.fn() }));

/**
 * F-207 (D-63): the commit. A reseller confirms the dry run and the worker
 * issues what it planned, a batch a tick. What fails silently here: a re-run
 * that issues a second Grant for a client already imported, one refused
 * client (past the cap, a wallet that cannot buy the bag) that stops the
 * rest, a user the import created recorded as found (so a rollback, F-211,
 * leaves them behind), a client the source had switched off imported live,
 * a run that never ends — and a source login that outlives it.
 */
const NOW = new Date('2026-10-21T12:00:00Z');
const GIB = 1024 ** 3;
const ADDRESS = 'https://old.example:8443';
const key = (remoteId: string) => `marzban|${ADDRESS}|${remoteId}`;
const DAY_MS = 86_400_000;

const RUN = {
  id: '00000000-0000-4000-8000-000000000207',
  tenantId: '00000000-0000-4000-8000-0000000000aa',
  actorUserId: '00000000-0000-4000-8000-0000000000bb',
  kind: MigrationRunKind.panel,
  sourceFamily: DriverType.marzban,
  sourceAddress: ADDRESS,
  status: MigrationRunStatus.committing,
  workerClaimedAt: null,
  committedItems: 0,
  failedItems: 0,
  rollbackUntil: null,
};

type Row = Record<string, unknown>;

const snapshot = (remoteId: string, over: Row = {}) => ({
  remoteId,
  label: `${remoteId} label`,
  uuid: `uuid-${remoteId}`,
  inboundRemoteId: 'vless-tcp',
  protocol: 'vless',
  enabled: true,
  dataLimitBytes: 20 * GIB,
  upBytes: GIB,
  downBytes: 2 * GIB,
  expiresAt: '2026-10-31T12:00:00.000Z',
  lines: [],
  linesRead: false,
  ...over,
});

const item = (remoteId: string, plannedAction: MigrationItemAction = MigrationItemAction.create, over: Row = {}): Row => ({
  id: `item-${remoteId}`,
  runId: RUN.id,
  tenantId: RUN.tenantId,
  remoteIdentity: key(remoteId),
  sourceSnapshot: snapshot(remoteId),
  plannedAction,
  skipReason: plannedAction === MigrationItemAction.skip ? 'expired' : null,
  outcome: MigrationItemOutcome.pending,
  failureReason: null,
  createdUserId: null,
  createdGrantId: null,
  createdConfigIds: [],
  createdAt: new Date(NOW.getTime() + Number(remoteId.length)),
  ...over,
});

/** The run, its items, the tenant's imported Grants and configs, in memory. */
function fakeDb(items: Row[], grants: Row[] = []) {
  const state = { run: { ...RUN } as Row, items, grants, outbox: [] as Row[], oldLinks: [] as Row[], grantUpdates: [] as Row[] };
  const runMatches = (where: Row) =>
    Object.entries(where).every(([k, v]) => k === 'OR' || (v instanceof Date ? (state.run[k] as Date | null)?.getTime() === v.getTime() : v === null ? state.run[k] === null : state.run[k] === v));
  const itemMatches = (i: Row, where: Row) => Object.entries(where).every(([k, v]) => i[k] === v);
  const bump = (data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in v) state.run[k] = (state.run[k] as number) + (v as { increment: number }).increment;
      else state.run[k] = v;
    }
  };
  const models: Record<string, Row> = {
    migrationRun: {
      findFirst: async () => ({ ...state.run }),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (!runMatches(where)) return { count: 0 };
        bump(data);
        return { count: 1 };
      },
    },
    migrationInbound: { findMany: async () => [{ inboundRemoteId: 'vless-tcp', variantId: 'variant-20gb' }, { inboundRemoteId: 'monthly-20G', variantId: 'variant-um' }] },
    migrationItem: {
      findMany: async ({ where, take }: { where: Row; take: number }) =>
        state.items.filter((i) => i['outcome'] === where['outcome'] && (where['plannedAction'] === undefined || i['plannedAction'] !== MigrationItemAction.skip)).slice(0, take),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = state.items.filter((i) => itemMatches(i, where));
        hit.forEach((i) => Object.assign(i, data));
        return { count: hit.length };
      },
    },
    grant: {
      findFirst: async ({ where }: { where: Row }) => state.grants.find((g) => g['remoteIdentity'] === where['remoteIdentity']) ?? null,
      update: async (args: Row) => state.grantUpdates.push(args),
    },
    config: { findMany: async ({ where }: { where: Row }) => [{ id: `config-of-${String(where['grantId'])}` }] },
    outboxEvent: { create: async ({ data }: { data: Row }) => state.outbox.push(data) },
    legacySubLink: { createMany: async ({ data }: { data: Row[] }) => ({ count: state.oldLinks.push(...data) && data.length }) },
  };
  const tx = new Proxy(models, { get: (target, name: string) => (name === '$executeRaw' ? async () => 0 : target[name]) });
  const prisma = { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as unknown as PrismaService;
  return { state, prisma, crossTenant: tx as unknown as CrossTenantPrismaService };
}

type Person = { remoteIdentity: string; userId: string; created: boolean };

function commit(db: ReturnType<typeof fakeDb>, opts: { people?: (asked: { remoteIdentity: string; label: string }[]) => Promise<{ users: Person[]; refused: { remoteIdentity: string; reason: string }[] }>; issue?: GrantService['issue'] } = {}) {
  const answer = opts.people ?? (async (asked) => ({ users: asked.map((a) => ({ remoteIdentity: a.remoteIdentity, userId: `user-${a.remoteIdentity}`, created: true })), refused: [] }));
  const people = { import: vi.fn((_tenantId: string, asked: { remoteIdentity: string; label: string }[]) => answer(asked)) };
  const issue = vi.fn(opts.issue ?? (async (_tx: unknown, input: { sourceReferenceId?: string | null }) => ({ grant: { id: `grant-${input.sourceReferenceId}` }, token: 'token' })));
  const fulfil = vi.fn(async () => ({ placed: 1, waiting: [], activated: false }));
  const destroy = vi.fn(async () => undefined);
  const adoptInPlace = vi.fn(async () => ({ configId: 'config-adopted', uuid: 'uuid-ours' }));
  const service = new MigrationCommitService(
    db.prisma,
    db.crossTenant,
    people as unknown as ImportedPeople,
    { issue } as unknown as GrantService,
    { fulfil } as unknown as GroupFulfilmentService,
    { destroy } as unknown as SourceLoginVault,
    { credit: vi.fn() } as never,
    { adoptInPlace } as unknown as ConfigActionsService,
  );
  return { run: () => service.commitNext(NOW), people, issue, fulfil, destroy, adoptInPlace };
}

const byId = (db: ReturnType<typeof fakeDb>, remoteId: string) => db.state.items.find((i) => i['remoteIdentity'] === key(remoteId)) as Row;

describe('importedGrantShape — what the source says over what the variant says', () => {
  const variant = { status: 'active', startsAt: NOW, endsAt: new Date(NOW.getTime() + 30 * DAY_MS), endSetAt: NOW, purchasedBytes: BigInt(50 * GIB), trafficUnlimited: false };
  const imported = { remoteIdentity: key('ali'), endsAt: new Date('2026-10-31T12:00:00Z'), purchasedBytes: BigInt(20 * GIB), consumedBytes: BigInt(3 * GIB), trafficUnlimited: false };

  it("takes the client's end, bag and usage, and carries its key", () => {
    expect(importedGrantShape(variant, imported)).toMatchObject({ endsAt: imported.endsAt, endSetAt: NOW, purchasedBytes: imported.purchasedBytes, consumedBytes: imported.consumedBytes, remoteIdentity: key('ali') });
  });

  it('counts what the source served as used from the first plan, so what is left is the bag less it (F-208)', () => {
    expect(importedGrantShape(variant, imported).importedUsedBytes).toBe(BigInt(3 * GIB));
  });

  it("keeps the variant's period for a client with no end there", () => {
    expect(importedGrantShape(variant, { ...imported, endsAt: null })).toMatchObject({ endsAt: variant.endsAt, endSetAt: NOW });
  });

  it('refuses an unlimited client on a limited variant, and the other way round', () => {
    expect(() => importedGrantShape(variant, { ...imported, trafficUnlimited: true, purchasedBytes: BigInt(0) })).toThrow(EntitlementRefused);
    expect(() => importedGrantShape({ ...variant, trafficUnlimited: true, purchasedBytes: BigInt(0) }, imported)).toThrow(/import_traffic_mismatch/);
  });
});

describe('MigrationCommitService — one committing run, one batch per tick', () => {
  beforeEach(() => vi.mocked(freezeGrant).mockReset());

  it('finds or makes each person, issues a migration Grant of the inbound’s variant from the source, places it, and records what it made', async () => {
    const db = fakeDb([item('ali')]);
    const c = commit(db);
    expect(await c.run()).toMatchObject({ outcome: 'batch', items: 1 });

    expect(c.people.import).toHaveBeenCalledWith(RUN.tenantId, [{ remoteIdentity: key('ali'), label: 'ali label' }]);
    expect(c.issue).toHaveBeenCalledWith(expect.anything(), {
      userId: `user-${key('ali')}`,
      variantId: 'variant-20gb',
      source: GrantSource.migration,
      sourceReferenceId: 'item-ali',
      startsAt: NOW,
      imported: { remoteIdentity: key('ali'), endsAt: new Date('2026-10-31T12:00:00Z'), purchasedBytes: BigInt(20 * GIB), consumedBytes: BigInt(3 * GIB), trafficUnlimited: false },
    });
    expect(c.fulfil).toHaveBeenCalledWith(expect.anything(), 'grant-item-ali');
    expect(byId(db, 'ali')).toMatchObject({ outcome: MigrationItemOutcome.created, createdUserId: `user-${key('ali')}`, createdGrantId: 'grant-item-ali', createdConfigIds: ['config-of-grant-item-ali'] });
    expect(db.state.run).toMatchObject({ committedItems: 1, failedItems: 0, status: MigrationRunStatus.committing, workerClaimedAt: null });
    expect(db.state.outbox).toEqual([expect.objectContaining({ type: OutboxEventType.MIGRATION_RUN_PROGRESS, payload: { tenantId: RUN.tenantId, userId: RUN.actorUserId, runId: RUN.id } })]);
  });

  it('claims the Telegram account the source named for the person, and keeps what came of it on the item (F-210)', async () => {
    const db = fakeDb([item('ali', MigrationItemAction.create, { sourceSnapshot: snapshot('ali', { telegramId: '123456' }) }), item('reza')]);
    const c = commit(db, { people: async (asked) => ({ users: asked.map((a) => ({ remoteIdentity: a.remoteIdentity, userId: `user-${a.remoteIdentity}`, created: true, ...(a.remoteIdentity === key('ali') ? { telegram: 'taken' } : {}) })), refused: [] }) });
    await c.run();
    expect(c.people.import).toHaveBeenCalledWith(RUN.tenantId, [{ remoteIdentity: key('ali'), label: 'ali label', telegramId: '123456' }, { remoteIdentity: key('reza'), label: 'reza label' }]);
    expect(byId(db, 'ali')).toMatchObject({ outcome: MigrationItemOutcome.created, telegramLink: 'taken' });
    expect(byId(db, 'reza')).not.toHaveProperty('telegramLink');
  });

  it('keeps the old link the source served the client at, so it answers once the old host points here (F-203-a)', async () => {
    const db = fakeDb([item('ali', MigrationItemAction.create, { sourceSnapshot: snapshot('ali', { subscriptionUrl: 'https://Sub.Old.example:2096/sub/tok-ali/' }) })]);
    await commit(db).run();
    expect(db.state.oldLinks).toEqual([{ tenantId: RUN.tenantId, host: 'sub.old.example', path: '/sub/tok-ali', grantId: 'grant-item-ali', migrationItemId: 'item-ali' }]);
  });

  it('never issues a second Grant for a key the tenant already holds: the item is updated, the Grant kept', async () => {
    const db = fakeDb([item('ali', MigrationItemAction.update)], [{ id: 'grant-earlier', remoteIdentity: key('ali') }]);
    const c = commit(db, { people: async () => ({ users: [{ remoteIdentity: key('ali'), userId: 'user-earlier', created: false }], refused: [] }) });
    await c.run();
    expect(c.issue).not.toHaveBeenCalled();
    expect(byId(db, 'ali')).toMatchObject({ outcome: MigrationItemOutcome.updated, createdUserId: null, createdGrantId: null });
    expect(db.state.run['committedItems']).toBe(1);
  });

  it('records a person found, not made, as no user of the run’s — a rollback must not remove them', async () => {
    const db = fakeDb([item('ali')]);
    const c = commit(db, { people: async () => ({ users: [{ remoteIdentity: key('ali'), userId: 'user-earlier', created: false }], refused: [] }) });
    await c.run();
    expect(byId(db, 'ali')).toMatchObject({ outcome: MigrationItemOutcome.created, createdUserId: null, createdGrantId: 'grant-item-ali' });
  });

  it('fails the client identity refused and the one whose Grant was refused, and goes on with the rest', async () => {
    const db = fakeDb([item('capped'), item('poor'), item('ali')]);
    const c = commit(db, {
      people: async (asked) => ({
        users: asked.filter((a) => a.remoteIdentity !== key('capped')).map((a) => ({ remoteIdentity: a.remoteIdentity, userId: `user-${a.remoteIdentity}`, created: true })),
        refused: [{ remoteIdentity: key('capped'), reason: 'over_cap' }],
      }),
      issue: async (_tx, input) => {
        if (input.sourceReferenceId === 'item-poor') throw new EntitlementRefused('wholesale_unfunded', 'variant-20gb');
        return { grant: { id: `grant-${input.sourceReferenceId}` }, token: 'token' } as Awaited<ReturnType<GrantService['issue']>>;
      },
    });
    await c.run();
    expect(byId(db, 'capped')).toMatchObject({ outcome: MigrationItemOutcome.failed, failureReason: 'over_cap' });
    expect(byId(db, 'poor')).toMatchObject({ outcome: MigrationItemOutcome.failed, failureReason: 'wholesale_unfunded' });
    expect(byId(db, 'ali')).toMatchObject({ outcome: MigrationItemOutcome.created });
    expect(db.state.run).toMatchObject({ committedItems: 1, failedItems: 2 });
  });

  it('imports a client the source had switched off frozen, by an admin, its clock running as it ran there', async () => {
    const db = fakeDb([item('off', MigrationItemAction.create, { sourceSnapshot: snapshot('off', { enabled: false }) })]);
    await commit(db).run();
    expect(freezeGrant).toHaveBeenCalledWith(expect.anything(), 'grant-item-off', { at: NOW, mode: FreezeMode.hard, stopsClock: false });
  });

  it('takes at most one batch a tick', async () => {
    const db = fakeDb(Array.from({ length: MIGRATION_COMMIT_BATCH_SIZE + 1 }, (_, n) => item(`u${String(n).padStart(4, '0')}`)));
    const c = commit(db);
    expect(await c.run()).toMatchObject({ outcome: 'batch', items: MIGRATION_COMMIT_BATCH_SIZE });
    expect(c.issue).toHaveBeenCalledTimes(MIGRATION_COMMIT_BATCH_SIZE);
  });

  it('ends the run once nothing is pending: skips recorded, the rollback window open, the source login destroyed', async () => {
    const db = fakeDb([item('old', MigrationItemAction.skip), item('ali', MigrationItemAction.create, { outcome: MigrationItemOutcome.created })]);
    const c = commit(db);
    expect(await c.run()).toMatchObject({ outcome: 'finished' });
    expect(byId(db, 'old')['outcome']).toBe(MigrationItemOutcome.skipped);
    expect(db.state.run).toMatchObject({ status: MigrationRunStatus.committed, rollbackUntil: new Date(NOW.getTime() + MIGRATION_ROLLBACK_DAYS * DAY_MS), workerClaimedAt: null });
    expect(c.destroy).toHaveBeenCalledWith(RUN.tenantId, RUN.id);
    expect(db.state.outbox).toHaveLength(1);
  });

  it('leaves an item pending on a passing database fault and stops the batch for the next tick; any other fault is final (LIVE-1-k)', async () => {
    const db = fakeDb([item('ali'), item('busy'), item('reza')]);
    const timeout = new Prisma.PrismaClientKnownRequestError('Transaction API error: Unable to start a transaction in the given time.', { code: 'P2028', clientVersion: 'test' });
    const c = commit(db, {
      issue: async (_tx, input) => {
        if (input.sourceReferenceId === 'item-busy') throw timeout;
        return { grant: { id: `grant-${input.sourceReferenceId}` }, token: 'token' } as Awaited<ReturnType<GrantService['issue']>>;
      },
    });
    expect(await c.run()).toMatchObject({ outcome: 'waiting', items: 1 });
    expect(byId(db, 'ali')).toMatchObject({ outcome: MigrationItemOutcome.created });
    expect(byId(db, 'busy')).toMatchObject({ outcome: MigrationItemOutcome.pending, failureReason: null });
    expect(byId(db, 'reza')['outcome']).toBe(MigrationItemOutcome.pending);
    expect(db.state.run).toMatchObject({ status: MigrationRunStatus.committing, workerClaimedAt: null, failedItems: 0 });

    const broken = fakeDb([item('ali')]);
    await commit(broken, { issue: async () => Promise.reject(new TypeError('a bug')) }).run();
    expect(byId(broken, 'ali')).toMatchObject({ outcome: MigrationItemOutcome.failed, failureReason: 'unexpected' });
  });

  it('writes nothing while identity cannot be asked, and leaves the run to the next tick', async () => {
    const db = fakeDb([item('ali')]);
    const c = commit(db, { people: async () => Promise.reject(new MigrationSeamUnavailable('auth down')) });
    expect(await c.run()).toMatchObject({ outcome: 'waiting', items: 0 });
    expect(c.issue).not.toHaveBeenCalled();
    expect(byId(db, 'ali')['outcome']).toBe(MigrationItemOutcome.pending);
    expect(db.state.run).toMatchObject({ status: MigrationRunStatus.committing, workerClaimedAt: null });
  });
});

describe('MigrationCommitService — a link run, one person from one old link (F-201-g)', () => {
  const LINK = 'https://old.example.com:2096/sub/Ab12';
  const read = linkClientOf(LINK, { userinfo: { uploadBytes: GIB, downloadBytes: 4 * GIB, totalBytes: 20 * GIB, expiresAt: 0 }, lines: ['vless://u@a:443'] });
  const CORRECTED_END = new Date('2026-11-01T00:00:00Z');

  function linkDb(run: Row, correction: Row = {}) {
    const db = fakeDb([
      item('link', MigrationItemAction.create, {
        remoteIdentity: linkIdentityOf(LINK),
        sourceSnapshot: { ...read, expiresAt: null },
        correctedDataLimitBytes: null,
        correctedUsedBytes: null,
        correctedExpiresAt: null,
        ...correction,
      }),
    ]);
    Object.assign(db.state.run, { kind: MigrationRunKind.link, sourceFamily: null, sourceAddress: LINK, userId: 'user-ali', variantId: 'variant-link', ...run });
    return db;
  }

  it("issues the run's own person a Grant of the chosen product with the admin's figures, asks identity for nobody, and keeps the old link", async () => {
    const db = linkDb({}, { correctedDataLimitBytes: BigInt(30 * GIB), correctedExpiresAt: CORRECTED_END });
    const c = commit(db);
    expect(await c.run()).toMatchObject({ outcome: 'batch', items: 1 });

    expect(c.people.import).not.toHaveBeenCalled();
    expect(c.issue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 'user-ali',
      variantId: 'variant-link',
      imported: { remoteIdentity: linkIdentityOf(LINK), endsAt: CORRECTED_END, purchasedBytes: BigInt(30 * GIB), consumedBytes: BigInt(5 * GIB), trafficUnlimited: false },
    }));
    // Found, never made: a rollback (F-211) closes the Grant and leaves the person.
    expect(db.state.items[0]).toMatchObject({ outcome: MigrationItemOutcome.created, createdUserId: null });
    expect(db.state.oldLinks).toEqual([expect.objectContaining({ host: 'old.example.com', path: '/sub/Ab12' })]);
  });

  it('ends with no source login to destroy: a link run never had one', async () => {
    const db = linkDb({});
    const c = commit(db);
    await c.run();
    expect(await c.run()).toMatchObject({ outcome: 'finished' });
    expect(c.destroy).not.toHaveBeenCalled();
  });

  it('fails the item of a run that reached the commit with no product, never guessing one', async () => {
    const db = linkDb({ variantId: null });
    const c = commit(db);
    await c.run();
    expect(c.issue).not.toHaveBeenCalled();
    expect(db.state.items[0]).toMatchObject({ outcome: MigrationItemOutcome.failed, failureReason: 'variant_unchosen' });
  });
});

describe('MigrationCommitService — a User Manager router imported in place (F-1601-b3)', () => {
  const ROUTER = 'https://10.20.0.1';
  const PANEL = '00000000-0000-4000-8000-0000000016a1';

  function inPlaceDb() {
    const um = { uuid: '', protocol: '', inboundRemoteId: 'monthly-20G', label: 'Ali R.' };
    const db = fakeDb([item('ali', MigrationItemAction.create, { remoteIdentity: `${DriverType.mikrotik_user_manager}|${ROUTER}|ali`, sourceSnapshot: snapshot('ali', um) })]);
    Object.assign(db.state.run, { sourceFamily: DriverType.mikrotik_user_manager, sourceAddress: ROUTER, sourcePanelId: PANEL });
    return db;
  }

  it('issues the Grant pinned to its router — no panel group — and its config that same user, never a new login (ADR-0160 decision 6)', async () => {
    const db = inPlaceDb();
    const c = commit(db);
    expect(await c.run()).toMatchObject({ outcome: 'batch', items: 1 });

    expect(c.issue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ variantId: 'variant-um', source: GrantSource.migration }));
    expect(c.fulfil).not.toHaveBeenCalled();
    expect(db.state.grantUpdates).toEqual([{ where: { id: 'grant-item-ali' }, data: { panelGroupId: null } }]);
    expect(c.adoptInPlace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      grantId: 'grant-item-ali',
      panelId: PANEL,
      remoteId: 'ali',
      adoptedProfile: 'monthly-20G',
      adoptedLabel: 'Ali R.',
    }));
    expect(db.state.items[0]).toMatchObject({ outcome: MigrationItemOutcome.created, createdGrantId: 'grant-item-ali', createdConfigIds: ['config-of-grant-item-ali'] });
  });
});
