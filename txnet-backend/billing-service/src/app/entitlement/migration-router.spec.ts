import { CounterSemantics, DriverType, PanelOwnershipType, PanelReviewState, PanelRole, PanelTransport } from '@prisma/client';
import { panelCredentialRef, runWithTenant, type ResellerAccess, type ResellerActor } from '@txnet-backend/shared-core';

import { PanelRegistrationService, type PanelCredentialWriter } from '../systems/panel-registration';
import { MigrationRouterService, RESELLER_ROUTER_REGION } from './migration-router';
import { MigrationRunRefused } from './migration-run';

/**
 * F-1601-g (ADR-0162): a reseller registers its own User Manager router, so
 * an import in place has something to name. What fails silently here: the
 * router written as the platform's (the session's tenant when the owner acts
 * in a reseller's workspace), its login sealed under the wrong tenant so the
 * vault never hands it to network, a family that is not imported in place
 * slipping past the owner-only systems page, and another tenant's router
 * listed or re-keyed.
 */
const RESELLER = '00000000-0000-4000-8000-0000000000aa';
const PLATFORM = '00000000-0000-4000-8000-000000000001';
const ROUTER_ID = '00000000-0000-4000-8000-0000000016a1';
const SECRET = '{"username":"api","password":"router-secret"}';
// The platform owner's staff, acting in the reseller's workspace (ADR-0064).
const ACTOR: ResellerActor = { userId: 'admin-1', tenantId: PLATFORM, permissions: [] };
const BODY = { family: DriverType.mikrotik_user_manager, name: 'home-router', apiBaseUrl: 'http://203.0.113.9/rest', credentials: SECRET };

type Row = Record<string, unknown>;

function harness(stored: Row[] = []) {
  const panels: Row[] = [];
  const seen: string[] = [];
  const queries: Row[] = [];
  const door = {
    for: (key: string) => ({
      run: (_actor: unknown, _tenantId: unknown, capability: string, work: () => unknown) => (seen.push(`${key}:${capability}`), work()),
    }),
  } as unknown as ResellerAccess;
  const panel = { findMany: async ({ where }: { where: Row }) => (queries.push(where), stored) };
  const prisma = { panel, $transaction: async (fn: (tx: unknown) => unknown) => fn({ panel, $executeRaw: async () => 0 }) };
  const all = {
    // No other panel holds the address (F-027-cd).
    $queryRaw: async () => [],
    panel: {
      findFirst: async ({ where }: { where: Row }) => stored.find((p) => p['id'] === where['id'] && p['tenantId'] === where['tenantId']) ?? null,
      create: async ({ data }: { data: Row }) => (panels.push(data), data),
      delete: async () => undefined,
      updateMany: async () => ({ count: 1 }),
    },
  };
  const written: Row[] = [];
  const vault: PanelCredentialWriter = {
    set: async (target, credentials, actorId, secret) => {
      written.push({ ...target, credentials, actorId, secret });
      return { configured: true, version: 1, rotatedAt: '2026-10-23T10:00:00.000Z' };
    },
  };
  const registration = new PanelRegistrationService(prisma as never, all as never, vault);
  const routers = new MigrationRouterService(prisma as never, door, registration);
  const inTenant = <T>(work: () => Promise<T>) => runWithTenant({ id: RESELLER }, work);
  return { routers, panels, written, seen, queries, inTenant };
}

describe('MigrationRouterService — a reseller registers its own router (F-1601-g)', () => {
  it("writes the path's reseller's router, declared by its family, its login sealed under the reseller", async () => {
    const h = harness();
    const out = await h.inTenant(() => h.routers.register(ACTOR, RESELLER, BODY));

    expect(out.reviewState).toBe(PanelReviewState.pending);
    expect(h.panels).toHaveLength(1);
    expect(h.panels[0]).toMatchObject({
      ownershipType: PanelOwnershipType.tenant,
      tenantId: RESELLER,
      name: 'home-router',
      apiBaseUrl: 'http://203.0.113.9/rest',
      driverType: DriverType.mikrotik_user_manager,
      transport: PanelTransport.pull,
      counterSemantics: CounterSemantics.cumulative,
      role: PanelRole.active,
      region: RESELLER_ROUTER_REGION,
      reviewState: PanelReviewState.pending,
      panelApiCredentials: panelCredentialRef(RESELLER, out.id),
    });
    expect(h.written).toEqual([{ tenantId: RESELLER, panelId: out.id, credentials: SECRET, actorId: 'admin-1', secret: 'login' }]);
    expect(h.seen).toEqual(['migration.manage:staffWrite']);
  });

  it('refuses a family that is not imported in place: those stay on the owner-only systems page', async () => {
    const h = harness();
    await expect(h.inTenant(() => h.routers.register(ACTOR, RESELLER, { ...BODY, family: DriverType.marzban }))).rejects.toMatchObject({
      reason: 'family_not_in_place',
    });
    expect(h.panels).toEqual([]);
    expect(h.written).toEqual([]);
  });

  it("lists the reseller's own live routers of a family imported in place, each by its address's origin and its verdict", async () => {
    const h = harness([
      {
        id: ROUTER_ID,
        tenantId: RESELLER,
        name: 'home-router',
        driverType: DriverType.mikrotik_user_manager,
        apiBaseUrl: 'http://203.0.113.9/rest',
        reviewState: PanelReviewState.accepted,
        connectionTestFault: null,
        connectionTestedAt: new Date('2026-10-23T10:05:00Z'),
      },
    ]);
    const { routers } = await h.inTenant(() => h.routers.list(ACTOR, RESELLER));

    expect(h.queries).toEqual([
      { ownershipType: PanelOwnershipType.tenant, tenantId: RESELLER, driverType: { in: [DriverType.mikrotik_user_manager] }, retiredAt: null },
    ]);
    expect(routers).toEqual([
      {
        id: ROUTER_ID,
        name: 'home-router',
        family: DriverType.mikrotik_user_manager,
        address: 'http://203.0.113.9',
        reviewState: PanelReviewState.accepted,
        fault: null,
        testedAt: '2026-10-23T10:05:00.000Z',
      },
    ]);
    expect(h.seen).toEqual(['migration.manage:read']);
  });

  it("re-enters a login only on the reseller's own router, sealed under the reseller", async () => {
    const h = harness([{ id: ROUTER_ID, tenantId: RESELLER, reviewState: PanelReviewState.pending, connectionTestFault: 'login_refused' }]);
    const out = await h.inTenant(() => h.routers.resubmit(ACTOR, RESELLER, ROUTER_ID, SECRET));
    expect(out).toMatchObject({ id: ROUTER_ID, retest: true });
    expect(h.written).toEqual([{ tenantId: RESELLER, panelId: ROUTER_ID, credentials: SECRET, actorId: 'admin-1', secret: 'login' }]);

    const other = '00000000-0000-4000-8000-0000000016a2';
    await expect(h.inTenant(() => h.routers.resubmit(ACTOR, RESELLER, other, SECRET))).rejects.toBeInstanceOf(MigrationRunRefused);
    await expect(h.inTenant(() => h.routers.resubmit(ACTOR, RESELLER, other, SECRET))).rejects.toMatchObject({ reason: 'panel_not_found' });
  });
});
