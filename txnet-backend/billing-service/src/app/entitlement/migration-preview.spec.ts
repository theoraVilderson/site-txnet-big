import { DriverType, MigrationItemAction, MigrationRunKind, MigrationRunStatus } from '@prisma/client';
import { endUserRoom, OutboxEventType } from '@txnet-backend/shared-core';

import type { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import type { PrismaService } from '../prisma/prisma.service';
import { INBOUNDS_UNMAPPED, MigrationPreviewService } from './migration-preview';
import { planRun, type RunPlanContext } from './migration-run-plan';
import { migrationInboundsSchema } from './migration-run.schema';
import { MigrationSeamRefused, type SourceSnapshotReader, type SubscriptionLinkProbe } from './migration-seams';

vi.mock('@txnet-backend/shared-core', async (actual) => ({ ...(await actual<typeof import('@txnet-backend/shared-core')>()), endUserRoom: vi.fn() }));

/**
 * F-206 (D-63): the dry run. A reseller sees, before anything is written,
 * who would be made, who is already here and who is left out and why. What
 * fails silently here: a client imported twice (once per inbound it sits on),
 * a person already imported counted against the reseller's room, a client
 * past the room planned as made, an unreadable client dropped from the report
 * instead of named in it — and a dry run that writes anything outside its two
 * tables (invariant 32).
 */
const NOW = new Date('2026-10-21T12:00:00Z');
const GIB = 1024 ** 3;
const ADDRESS = 'https://old.example:8443';
const key = (remoteId: string) => `marzban|${ADDRESS}|${remoteId}`;

const client = (remoteId: string, over: Record<string, unknown> = {}) => ({
  remoteId,
  label: remoteId,
  uuid: `uuid-${remoteId}`,
  inboundRemoteId: 'vless-tcp',
  protocol: 'vless',
  enabled: true,
  dataLimitBytes: 20 * GIB,
  upBytes: GIB,
  downBytes: 2 * GIB,
  expiresAt: '2026-10-31T12:00:00Z',
  lines: [],
  linesRead: false,
  ...over,
});

const context = (over: Partial<RunPlanContext> = {}): RunPlanContext => ({
  family: DriverType.marzban,
  sourceAddress: ADDRESS,
  now: NOW,
  variantOf: new Map([['vless-tcp', 'variant-20gb']]),
  skippedInbounds: new Set(),
  unlimitedVariants: new Set(),
  importedGrants: new Set(),
  importedUsers: new Set(),
  userRoom: null,
  ...over,
});

const actions = (plan: ReturnType<typeof planRun>) => plan.items.map((i) => [i.remoteIdentity, i.plannedAction, i.skipReason]);

describe('planRun — the report', () => {
  it('plans a create, names each skip with its reason, and counts the three', () => {
    const plan = planRun(
      [
        client('ali'),
        client('old', { expiresAt: '2026-10-01T00:00:00Z' }),
        client('naive', { protocol: 'naive' }),
        client('ali2', { uuid: 'uuid-ali' }),
        client('broken', { upBytes: -1 }),
        { label: 'no id at all' },
      ],
      context(),
    );
    expect(actions(plan)).toEqual([
      [key('ali'), MigrationItemAction.create, null],
      [key('old'), MigrationItemAction.skip, 'expired'],
      [key('naive'), MigrationItemAction.skip, 'unknown_protocol'],
      [key('ali2'), MigrationItemAction.skip, 'duplicate'],
      [key('broken'), MigrationItemAction.skip, 'unreadable'],
    ]);
    expect(plan).toMatchObject({ plannedCreate: 1, plannedUpdate: 0, plannedSkip: 5, unaddressed: 1 });
  });

  it('keeps the client as read on its item, its end as text, and only the id of an unreadable one', () => {
    const plan = planRun([client('ali'), client('broken', { dataLimitBytes: 'lots' })], context());
    expect(plan.items[0].sourceSnapshot).toMatchObject({ remoteId: 'ali', dataLimitBytes: 20 * GIB, expiresAt: '2026-10-31T12:00:00.000Z' });
    expect(plan.items[1].sourceSnapshot).toEqual({ remoteId: 'broken' });
  });

  it("skips a client whose traffic the inbound's product does not sell as traffic_mismatch, both ways (F-208)", () => {
    const limited = planRun([client('ali'), client('free', { dataLimitBytes: 0 })], context());
    expect(actions(limited)).toEqual([
      [key('ali'), MigrationItemAction.create, null],
      [key('free'), MigrationItemAction.skip, 'traffic_mismatch'],
    ]);
    const unlimited = planRun([client('ali'), client('free', { dataLimitBytes: 0 })], context({ unlimitedVariants: new Set(['variant-20gb']) }));
    expect(actions(unlimited)).toEqual([
      [key('ali'), MigrationItemAction.skip, 'traffic_mismatch'],
      [key('free'), MigrationItemAction.create, null],
    ]);
  });

  it('skips every client of an inbound the reseller chose not to import as inbound_skipped (LIVE-1-h)', () => {
    const plan = planRun([client('ali'), client('test1', { inboundRemoteId: 'test-ws' })], context({ skippedInbounds: new Set(['test-ws']) }));
    expect(actions(plan)).toEqual([
      [key('ali'), MigrationItemAction.create, null],
      [key('test1'), MigrationItemAction.skip, 'inbound_skipped'],
    ]);
    expect(plan).toMatchObject({ plannedCreate: 1, plannedSkip: 1 });
  });

  it('plans an update, never a second Grant, for a key the tenant already holds', () => {
    const plan = planRun([client('ali'), client('reza')], context({ importedGrants: new Set([key('ali')]), importedUsers: new Set([key('ali')]) }));
    expect(actions(plan)).toEqual([
      [key('ali'), MigrationItemAction.update, null],
      [key('reza'), MigrationItemAction.create, null],
    ]);
  });

  it('skips past the room as over_cap; a person already imported takes none of it', () => {
    const plan = planRun([client('known'), client('new1'), client('new2')], context({ userRoom: 1, importedUsers: new Set([key('known')]) }));
    expect(actions(plan)).toEqual([
      [key('known'), MigrationItemAction.create, null],
      [key('new1'), MigrationItemAction.create, null],
      [key('new2'), MigrationItemAction.skip, 'over_cap'],
    ]);
  });

  it('plans a client the snapshot lists twice once', () => {
    expect(planRun([client('ali'), client('ali')], context()).items).toHaveLength(1);
  });
});

type Row = Record<string, unknown>;

/** A fake pool: the run, its inbounds and items in memory, and every model the dry run touches, by name. */
function fakeDb(run: Row) {
  const state = { run: { ...run }, inbounds: [] as Row[], items: [] as Row[], outbox: [] as Row[], touched: new Set<string>() };
  const matches = (where: Row) => Object.entries(where).every(([k, v]) => k === 'OR' || (v instanceof Date ? (state.run[k] as Date | null)?.getTime() === v.getTime() : state.run[k] === v));
  const models: Record<string, Row> = {
    migrationRun: {
      findFirst: async () => ({ ...state.run }),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(where)) return { count: 0 };
        Object.assign(state.run, data);
        return { count: 1 };
      },
    },
    migrationInbound: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ create, update }: { create: Row; update: Row }) => {
        const prior = state.inbounds.find((i) => i['inboundRemoteId'] === create['inboundRemoteId']);
        if (prior) Object.assign(prior, update);
        else state.inbounds.push({ variantId: null, ...create });
      },
      count: async () => state.inbounds.filter((i) => i['variantId'] === null && !i['skipped'] && (i['clientCount'] as number) > 0).length,
      findMany: async () => state.inbounds,
    },
    migrationItem: {
      deleteMany: async () => ({ count: (state.items.length = 0) }),
      createMany: async ({ data }: { data: Row[] }) => ({ count: state.items.push(...data) }),
    },
    grant: { findMany: async () => [] },
    user: { findMany: async () => [] },
    productVariant: { findMany: async () => [{ id: 'variant-20gb', quotas: { traffic_bytes: { limit: 20 * GIB } } }] },
    outboxEvent: { create: async ({ data }: { data: Row }) => state.outbox.push(data) },
  };
  const tx = new Proxy(models, {
    get(target, name: string) {
      if (name === '$executeRaw') return async () => 0;
      state.touched.add(name);
      return target[name];
    },
  });
  const prisma = { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as unknown as PrismaService;
  return { state, prisma, crossTenant: tx as unknown as CrossTenantPrismaService };
}

const RUN = {
  id: '00000000-0000-4000-8000-000000000206',
  tenantId: '00000000-0000-4000-8000-0000000000aa',
  actorUserId: '00000000-0000-4000-8000-0000000000bb',
  kind: MigrationRunKind.panel,
  sourceFamily: DriverType.marzban,
  sourceAddress: ADDRESS,
  status: MigrationRunStatus.previewing,
  workerClaimedAt: null,
};

const SNAPSHOT = { inbounds: [{ remoteId: 'vless-tcp', tag: 'VLESS TCP', protocol: 'vless' }], clients: [client('ali'), client('old', { expiresAt: '2026-10-01T00:00:00Z' })] };

function preview(db: ReturnType<typeof fakeDb>, snapshot: () => Promise<unknown>) {
  const reader = { snapshot: vi.fn(snapshot) } as unknown as SourceSnapshotReader;
  // A panel run never reads a link: the probe answering would be a bug.
  const links = { read: vi.fn(() => Promise.reject(new Error('a panel run read a link'))) } as unknown as SubscriptionLinkProbe;
  return new MigrationPreviewService(db.prisma, db.crossTenant, reader, links).previewNext(NOW);
}

describe('MigrationPreviewService — one previewing run per tick', () => {
  beforeEach(() => vi.mocked(endUserRoom).mockResolvedValue(null));

  it('sends a run whose inbound has clients and no variant back to draft, its inbounds recorded and no item written', async () => {
    const db = fakeDb(RUN);
    expect(await preview(db, async () => SNAPSHOT)).toBe('returned');
    expect(db.state.run).toMatchObject({ status: MigrationRunStatus.draft, failureReason: INBOUNDS_UNMAPPED, workerClaimedAt: null });
    expect(db.state.inbounds).toEqual([expect.objectContaining({ inboundRemoteId: 'vless-tcp', tag: 'VLESS TCP', clientCount: 2, variantId: null })]);
    expect(db.state.items).toEqual([]);
    expect(db.state.outbox).toEqual([expect.objectContaining({ type: OutboxEventType.MIGRATION_RUN_PROGRESS, payload: { tenantId: RUN.tenantId, userId: RUN.actorUserId, runId: RUN.id } })]);
  });

  it('writes the report once every inbound is mapped — and nothing outside the run, its inbounds, its items and the page event', async () => {
    const db = fakeDb(RUN);
    db.state.inbounds.push({ inboundRemoteId: 'vless-tcp', variantId: 'variant-20gb', clientCount: 2 });
    expect(await preview(db, async () => SNAPSHOT)).toBe('previewed');
    expect(db.state.run).toMatchObject({ status: MigrationRunStatus.previewed, plannedCreate: 1, plannedUpdate: 0, plannedSkip: 1, failureReason: null });
    expect(db.state.items.map((i) => [i['remoteIdentity'], i['plannedAction'], i['runId'], i['tenantId']])).toEqual([
      [key('ali'), MigrationItemAction.create, RUN.id, RUN.tenantId],
      [key('old'), MigrationItemAction.skip, RUN.id, RUN.tenantId],
    ]);
    const writable = ['migrationRun', 'migrationInbound', 'migrationItem', 'outboxEvent'];
    expect([...db.state.touched].filter((m) => !writable.includes(m)).sort()).toEqual(['grant', 'productVariant', 'user']);
  });

  it('previews a run whose only inbound with clients is skipped: nobody imported, each named inbound_skipped (LIVE-1-h)', async () => {
    const db = fakeDb(RUN);
    db.state.inbounds.push({ inboundRemoteId: 'vless-tcp', variantId: null, skipped: true, clientCount: 2 });
    expect(await preview(db, async () => SNAPSHOT)).toBe('previewed');
    expect(db.state.run).toMatchObject({ status: MigrationRunStatus.previewed, plannedCreate: 0, plannedSkip: 2 });
    expect(db.state.items.map((i) => i['skipReason'])).toEqual(['inbound_skipped', 'inbound_skipped']);
  });

  it("keeps the source's refusal as the reason the run went back to draft", async () => {
    const db = fakeDb(RUN);
    expect(await preview(db, async () => Promise.reject(new MigrationSeamRefused(422, 'source_login_refused')))).toBe('returned');
    expect(db.state.run).toMatchObject({ status: MigrationRunStatus.draft, failureReason: 'source_login_refused' });
  });

  it('leaves a run cancelled while its source was read as the reseller left it', async () => {
    const db = fakeDb(RUN);
    db.state.inbounds.push({ inboundRemoteId: 'vless-tcp', variantId: 'variant-20gb', clientCount: 2 });
    expect(
      await preview(db, async () => {
        db.state.run['status'] = MigrationRunStatus.cancelled;
        return SNAPSHOT;
      }),
    ).toBe('lost');
    expect(db.state.run['status']).toBe(MigrationRunStatus.cancelled);
    expect(db.state.items).toEqual([]);
  });
});

describe('the mapping body (LIVE-1-h)', () => {
  const parse = (inbound: Record<string, unknown>) => migrationInboundsSchema.safeParse({ inbounds: [{ inboundRemoteId: 'test-ws', ...inbound }] }).success;

  it('takes a variant, an undecided null, or an explicit skip — never a skip with a variant', () => {
    expect(parse({ variantId: '00000000-0000-4000-8000-000000000001' })).toBe(true);
    expect(parse({ variantId: null })).toBe(true);
    expect(parse({ variantId: null, skip: true })).toBe(true);
    expect(parse({ variantId: '00000000-0000-4000-8000-000000000001', skip: true })).toBe(false);
  });
});
