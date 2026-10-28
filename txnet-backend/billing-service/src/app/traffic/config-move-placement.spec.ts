/**
 * A move places like a purchase on its target (ADR-0160 decision 10). What
 * would break silently, and nowhere else:
 *
 *  - **a protocol the target does not sell** — a router login (`router_login`) moved
 *    to an Xray panel — was kept on the new row, network found no inbound of
 *    it (`no_inbound`), and the user lost the old login for nothing. The move
 *    now places on the target's picked inbounds, by its settings and caps;
 *  - **a target nothing can be placed on is refused before anything retires**,
 *    so the old row is still the user's.
 */
import { ActorType, ConfigProtocol, ConfigStatus, DesiredRemote, EnforcementState, InboundPlacement, PanelReviewState, PanelState, Prisma } from '@prisma/client';

import type { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { ConfigActionsService } from './config-actions';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999991';
const ROUTER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const XRAY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADMIN = { actorType: ActorType.admin, actorId: '33333333-3333-4333-8333-333333333333' };

type Row = Record<string, unknown> & { id: string };
type Inbound = { remoteId: string; protocol: ConfigProtocol; maxClients: number | null };
/** One row of `membersWithLoad`'s count: an inbound's configs on the target. */
type Load = { panelId: string; inboundRemoteId: string | null; total: number; clients: bigint; users: bigint; groupClients: bigint; groupUsers: bigint };

function build(target: { inbounds: Inbound[]; inboundPlacement?: InboundPlacement; panelState?: PanelState }, load: Load[] = []) {
  const configs: Row[] = [];
  let next = 0;
  const addConfig = (data: Record<string, unknown>): Row => {
    const row: Row = { id: `config-${++next}`, status: ConfigStatus.active, regenerateUsedCount: 0, maxRegenerateCount: 3, ...data };
    configs.push(row);
    return row;
  };
  const locks: unknown[] = [];
  const panel = {
    id: XRAY,
    tenantId: TENANT,
    retiredAt: null,
    reviewState: PanelReviewState.accepted,
    panelState: target.panelState ?? PanelState.healthy,
    driftEvents: [],
    inboundPlacement: target.inboundPlacement ?? InboundPlacement.all,
    maxClients: null,
    inboundsPerBuyer: null,
    inbounds: target.inbounds,
  };
  const tx = {
    $executeRaw: async (...args: unknown[]) => locks.push(args),
    grant: { findUnique: async () => ({ id: GRANT, tenantId: TENANT, userId: USER, status: 'active', trafficUnlimited: false, panelGroupId: null }) },
    panel: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === XRAY ? panel : { id: ROUTER, tenantId: TENANT, retiredAt: null }) },
    panelGroupMember: { findUnique: async () => null },
    config: {
      create: async ({ data }: { data: Record<string, unknown> }) => addConfig(data),
      createManyAndReturn: async ({ data }: { data: Record<string, unknown>[] }) => data.map(addConfig),
      findUnique: async ({ where }: { where: { id: string } }) => configs.find((c) => c.id === where.id) ?? null,
      // A live row matching every equality in `where`; `{ not: retired }` is the live part.
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        configs.filter((c) => c.status !== ConfigStatus.retired && Object.entries(where).every(([k, v]) => (typeof v === 'object' && v !== null) || c[k] === v)),
      updateMany: async ({ where, data }: { where: { id: string; status: ConfigStatus }; data: Record<string, unknown> }) => {
        const hit = configs.filter((c) => c.id === where.id && c.status === where.status);
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
    configActionLog: { create: async () => ({}), createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }) },
  };
  const crossTenant = { $queryRaw: async () => load } as unknown as CrossTenantPrismaService;
  const service = new ConfigActionsService(null, crossTenant);
  return { service, tx: tx as unknown as Prisma.TransactionClient, configs, locks };
}

/** The Grant's router login, adopted in place (F-1601-b3): `router_login` (F-1601-d3), no inbound of its own. */
function onRouter(configs: Row[]): string {
  configs.push({
    id: 'router-login',
    tenantId: TENANT,
    userId: USER,
    grantId: GRANT,
    panelId: ROUTER,
    protocol: ConfigProtocol.router_login,
    status: ConfigStatus.active,
    desiredRemote: DesiredRemote.present,
    enforcementState: EnforcementState.complete,
    regenerateUsedCount: 0,
    maxRegenerateCount: 3,
  });
  return 'router-login';
}

const XRAY_PICKS: Inbound[] = [
  { remoteId: '1', protocol: ConfigProtocol.vless, maxClients: null },
  { remoteId: '2', protocol: ConfigProtocol.vmess, maxClients: 10 },
];

describe('a move places like a purchase on its target (ADR-0160 decision 10)', () => {
  it('places a router login moved to an Xray panel on every picked inbound under `all`, as one credential group', async () => {
    const { service, tx, configs, locks } = build({ inbounds: XRAY_PICKS });
    const configId = onRouter(configs);

    const moved = await service.move(tx, { configId, toPanelId: XRAY, actor: ADMIN });

    // The login stays until the new config is confirmed, plus the grace (decision 11).
    expect(configs[0]).toMatchObject({ status: ConfigStatus.active, desiredRemote: DesiredRemote.present });
    const made = configs.slice(1);
    expect(made.map((c) => [c.panelId, c.inboundRemoteId, c.protocol])).toEqual([
      [XRAY, '1', ConfigProtocol.vless],
      [XRAY, '2', ConfigProtocol.vmess],
    ]);
    expect(made[0].credentialGroupId).toEqual(expect.any(String));
    expect(made[1].credentialGroupId).toBe(made[0].credentialGroupId);
    expect(moved).toMatchObject({ configId: made[0].id, retiredConfigId: configId });
    // Counted under the target's lock, as a sale on it is: two placements never take one last seat.
    expect(locks).toHaveLength(1);
  });

  it("holds the target's caps: an inbound at its `maxClients` is passed over", async () => {
    const full: Load = { panelId: XRAY, inboundRemoteId: '2', total: 0, clients: BigInt(10), users: BigInt(10), groupClients: BigInt(0), groupUsers: BigInt(0) };
    const { service, tx, configs } = build({ inbounds: XRAY_PICKS }, [full]);
    const configId = onRouter(configs);

    await service.move(tx, { configId, toPanelId: XRAY, actor: ADMIN });

    expect(configs.slice(1).map((c) => c.inboundRemoteId)).toEqual(['1']);
  });

  it('keeps the protocol where the target sells it: one row, the inbound left to the pass, no credential group', async () => {
    const { service, tx, configs, locks } = build({ inbounds: [{ remoteId: '7', protocol: ConfigProtocol.router_login, maxClients: null }] });
    const configId = onRouter(configs);

    await service.move(tx, { configId, toPanelId: XRAY, actor: ADMIN });

    expect(configs.slice(1)).toEqual([expect.objectContaining({ panelId: XRAY, protocol: ConfigProtocol.router_login, inboundRemoteId: null, credentialGroupId: null })]);
    expect(locks).toHaveLength(0);
  });

  it.each([
    ['sells nothing', { inbounds: [] }],
    ['is down', { inbounds: XRAY_PICKS, panelState: PanelState.down }],
  ])('refuses a target that %s before anything retires', async (_, target) => {
    const { service, tx, configs } = build(target);
    const configId = onRouter(configs);

    await expect(service.move(tx, { configId, toPanelId: XRAY, actor: ADMIN })).rejects.toMatchObject({ name: 'ConfigActionRefused', reason: 'no_placement_on_target' });
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ status: ConfigStatus.active, desiredRemote: DesiredRemote.present });
  });

  it('places on a User Manager router: its NAS is a `router_login` pick, so a moved Xray config gets a router login there (F-1601-d3)', async () => {
    const { service, tx, configs } = build({ inbounds: [{ remoteId: 'nas-tehran', protocol: ConfigProtocol.router_login, maxClients: null }] });
    configs.push({ id: 'xray-1', tenantId: TENANT, userId: USER, grantId: GRANT, panelId: ROUTER, protocol: ConfigProtocol.vless, status: ConfigStatus.active, regenerateUsedCount: 0, maxRegenerateCount: 3 });

    await service.move(tx, { configId: 'xray-1', toPanelId: XRAY, actor: ADMIN });

    expect(configs.slice(1).map((c) => [c.inboundRemoteId, c.protocol])).toEqual([['nas-tehran', ConfigProtocol.router_login]]);
  });

  it('records an adopted router login as `router_login`, the protocol its NAS names (F-1601-d3)', async () => {
    const { service, tx, configs } = build({ inbounds: [] });

    await service.adoptInPlace(tx, { grantId: GRANT, panelId: ROUTER, remoteId: 'ali', adoptedProfile: 'gold', adoptedLabel: 'Ali', actor: ADMIN });

    expect(configs[0]).toMatchObject({ protocol: ConfigProtocol.router_login, remoteId: 'ali' });
  });
});
