import { DriverType, MigrationItemAction, MigrationRunKind, MigrationRunStatus, PanelReviewState } from '@prisma/client';
import { endUserRoom, runWithTenant, type ResellerAccess, type ResellerActor } from '@txnet-backend/shared-core';

import type { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import type { PrismaService } from '../prisma/prisma.service';
import { MigrationPreviewService } from './migration-preview';
import { MigrationRunRefused, MigrationRunService } from './migration-run';
import { planRun, type RunPlanContext } from './migration-run-plan';
import type { SourceLoginVault, SourceSnapshotReader, SubscriptionLinkProbe } from './migration-seams';

vi.mock('@txnet-backend/shared-core', async (actual) => ({ ...(await actual<typeof import('@txnet-backend/shared-core')>()), endUserRoom: vi.fn() }));

/**
 * F-1601-b1 (ADR-0160): a reseller's MikroTik User Manager is imported in
 * place. The run names the router already registered as the tenant's panel —
 * never an address and a login typed again — and its dry run maps each
 * profile to a product, as an Xray import maps an inbound. What fails
 * silently here: every user skipped `unknown_protocol` (a profile names no
 * protocol), a user holding no profile left as an inbound nobody can map so
 * the run never previews, and another tenant's router read.
 */
const NOW = new Date('2026-10-23T12:00:00Z');
const GIB = 1024 ** 3;
const ROUTER = 'https://10.20.0.1';
const PANEL_ID = '00000000-0000-4000-8000-0000000016a1';
const TENANT = '00000000-0000-4000-8000-0000000000aa';
const key = (name: string) => `${DriverType.mikrotik_user_manager}|${ROUTER}|${name}`;

/** A User Manager user as network's snapshot answers it: no uuid, no protocol, its profile as its inbound. */
const user = (name: string, over: Record<string, unknown> = {}) => ({
  remoteId: name,
  label: name,
  uuid: '',
  inboundRemoteId: 'monthly-20G',
  protocol: '',
  enabled: true,
  dataLimitBytes: 20 * GIB,
  upBytes: GIB,
  downBytes: 3 * GIB,
  expiresAt: '2026-11-01T05:30:00Z',
  lines: [],
  linesRead: false,
  ...over,
});

const context = (): RunPlanContext => ({
  family: DriverType.mikrotik_user_manager,
  sourceAddress: ROUTER,
  now: NOW,
  variantOf: new Map([['monthly-20G', 'variant-20gb']]),
  unlimitedVariants: new Set(),
  importedGrants: new Set(),
  importedUsers: new Set(),
  userRoom: null,
});

describe('planRun — a User Manager router read in place', () => {
  it("plans each user onto its profile's product though it names no protocol, and skips one holding no profile as no_inbound", () => {
    const plan = planRun([user('ali'), user('reza', { inboundRemoteId: '' })], context());
    expect(plan.items.map((i) => [i.remoteIdentity, i.plannedAction, i.skipReason])).toEqual([
      [key('ali'), MigrationItemAction.create, null],
      [key('reza'), MigrationItemAction.skip, 'no_inbound'],
    ]);
  });
});

type Row = Record<string, unknown>;

/** The tables an in-place run touches, in memory; `$transaction` hands the same models back. */
function fakeDb(run: Row | null, panels: Row[] = []) {
  const state = { run: run && { ...run }, created: [] as Row[], inbounds: [] as Row[], items: [] as Row[], panelWhere: [] as Row[] };
  const models: Record<string, Row> = {
    migrationRun: {
      findFirst: async () => state.run && { ...state.run },
      create: async ({ data }: { data: Row }) => {
        state.created.push(data);
        return { id: 'new-run', status: MigrationRunStatus.draft, ...data };
      },
      update: async ({ data }: { data: Row }) => Object.assign(state.run ?? {}, data),
      updateMany: async ({ data }: { data: Row }) => (Object.assign(state.run ?? {}, data), { count: 1 }),
    },
    panel: {
      findFirst: async ({ where }: { where: Row }) => {
        state.panelWhere.push(where);
        return panels.find((p) => p['id'] === where['id'] && p['tenantId'] === where['tenantId'] && p['driverType'] === where['driverType']) ?? null;
      },
    },
    migrationInbound: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ create }: { create: Row }) => state.inbounds.push({ variantId: null, ...create }),
      count: async () => state.inbounds.filter((i) => i['variantId'] === null && (i['clientCount'] as number) > 0).length,
      findMany: async () => state.inbounds,
    },
    migrationItem: { deleteMany: async () => ({ count: 0 }), createMany: async ({ data }: { data: Row[] }) => ({ count: state.items.push(...data) }) },
    grant: { findMany: async () => [] },
    user: { findMany: async () => [] },
    productVariant: { findMany: async () => [] },
    outboxEvent: { create: async () => ({}) },
  };
  const tx = new Proxy(models, { get: (target, name: string) => (name === '$executeRaw' ? async () => 0 : target[name]) });
  const prisma = { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as unknown as PrismaService;
  return { state, prisma, crossTenant: tx as unknown as CrossTenantPrismaService };
}

const IN_PLACE_RUN = {
  id: '00000000-0000-4000-8000-000000001601',
  tenantId: TENANT,
  actorUserId: '00000000-0000-4000-8000-0000000000bb',
  kind: MigrationRunKind.panel,
  sourceFamily: DriverType.mikrotik_user_manager,
  sourceAddress: ROUTER,
  sourcePanelId: PANEL_ID,
  status: MigrationRunStatus.previewing,
  workerClaimedAt: null,
};

describe('MigrationPreviewService — an in-place run', () => {
  beforeEach(() => vi.mocked(endUserRoom).mockResolvedValue(null));

  it('reads the snapshot through the registered panel, and records no inbound for a user on no profile', async () => {
    const db = fakeDb(IN_PLACE_RUN);
    const snapshot = vi.fn(async () => ({ inbounds: [{ remoteId: 'monthly-20G', tag: 'monthly-20G', protocol: '' }], clients: [user('ali'), user('reza', { inboundRemoteId: '' })] }));
    const links = { read: vi.fn() } as unknown as SubscriptionLinkProbe;
    await new MigrationPreviewService(db.prisma, db.crossTenant, { snapshot } as unknown as SourceSnapshotReader, links).previewNext(NOW);
    expect(snapshot).toHaveBeenCalledWith(TENANT, DriverType.mikrotik_user_manager, { panelId: PANEL_ID });
    expect(db.state.inbounds.map((i) => [i['inboundRemoteId'], i['clientCount']])).toEqual([['monthly-20G', 1]]);
  });
});

const ACTOR = { userId: IN_PLACE_RUN.actorUserId } as ResellerActor;
const OPEN_DOOR = { for: () => ({ run: (_a: unknown, _t: unknown, _c: unknown, work: () => unknown) => work() }) } as unknown as ResellerAccess;
const ROUTER_PANEL = { id: PANEL_ID, tenantId: TENANT, driverType: DriverType.mikrotik_user_manager, apiBaseUrl: `${ROUTER}/` };

/** The run's routes, as a reseller's request reaches them: inside the tenant's scope. */
function service(db: ReturnType<typeof fakeDb>) {
  const runs = new MigrationRunService(db.prisma, OPEN_DOOR, { destroy: vi.fn() } as unknown as SourceLoginVault);
  return {
    create: (...a: Parameters<MigrationRunService['create']>) => runWithTenant({ id: TENANT }, () => runs.create(...a)),
    commit: (...a: Parameters<MigrationRunService['commit']>) => runWithTenant({ id: TENANT }, () => runs.commit(...a)),
  };
}

describe('MigrationRunService — an in-place run', () => {
  it("names the tenant's accepted panel of the family, keyed by the panel's own address", async () => {
    const db = fakeDb(null, [ROUTER_PANEL]);
    await service(db).create(ACTOR, TENANT, { family: DriverType.mikrotik_user_manager, panelId: PANEL_ID });
    expect(db.state.created).toEqual([expect.objectContaining({ sourceFamily: DriverType.mikrotik_user_manager, sourceAddress: ROUTER, sourcePanelId: PANEL_ID })]);
    expect(db.state.panelWhere[0]).toMatchObject({ reviewState: { in: [PanelReviewState.accepted, PanelReviewState.accepted_low_trust] }, retiredAt: null });
  });

  it("refuses another tenant's router, an in-place family named by an address, and a panel for a family read through a login", async () => {
    const other = fakeDb(null, [{ ...ROUTER_PANEL, tenantId: 'someone-else' }]);
    await expect(service(other).create(ACTOR, TENANT, { family: DriverType.mikrotik_user_manager, panelId: PANEL_ID })).rejects.toMatchObject({ reason: 'panel_not_found' });
    const db = fakeDb(null, [ROUTER_PANEL]);
    await expect(service(db).create(ACTOR, TENANT, { family: DriverType.mikrotik_user_manager, sourceAddress: ROUTER })).rejects.toMatchObject({ reason: 'panel_required' });
    await expect(service(db).create(ACTOR, TENANT, { family: DriverType.marzban, panelId: PANEL_ID })).rejects.toBeInstanceOf(MigrationRunRefused);
    expect(db.state.created).toEqual([]);
  });

  it('starts the commit: each user is adopted where it is, never placed by a group (F-1601-b3)', async () => {
    const db = fakeDb({ ...IN_PLACE_RUN, status: MigrationRunStatus.previewed });
    await expect(service(db).commit(ACTOR, TENANT, IN_PLACE_RUN.id)).resolves.toMatchObject({ status: MigrationRunStatus.committing });
  });
});
