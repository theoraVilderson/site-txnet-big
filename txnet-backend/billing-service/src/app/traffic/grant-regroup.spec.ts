/**
 * Moving a Grant to another panel group (F-027-et, ADR-0127 decision 5). What
 * would break silently:
 *
 *  - **a config the target also sells there gets a new link** — the ADR's
 *    point is that users moved between groups sharing an inbound keep theirs;
 *    only the rest are moved (drained, then placed by the target's fulfilment);
 *  - **a kept config overfills the target's share** — a share counts the
 *    group's own Grants, so a Grant joining with a config there takes a seat;
 *  - **a move that leaves the user with no line** — a target whose panels
 *    cannot place it now is `no_target`, and the whole move rolls back;
 *  - a target the Grant may not use, one that cannot deliver, the same group,
 *    or a Grant with no group is refused before anything is written;
 *  - a reseller's own people spend its platform-panel room only when the move
 *    takes the Grant onto a platform panel it was not on;
 *  - **a reseller's Grant sold with no wholesale leg reaches a platform panel**
 *    (F-118-n7): nobody would pay the platform for what it serves there.
 */
import { ConfigProtocol, GrantStatus, InboundPlacement, PanelGroupMemberRole, PanelReviewState, PanelState, TenantType } from '@prisma/client';
import { vi } from 'vitest';

import { MemberFacts } from './group-plan';
import { GrantRegroupActs, GrantRegroupRefused, RegroupInput, splitForTarget } from './grant-regroup';

const grantAudits: { grantId: string; reason: string | null }[] = [];
const configAudits: { configId: string; action: string }[] = [];
vi.mock('../grant-audit/grant-audit', () => ({
  auditedGrantRegroup: async (_tx: unknown, _actor: unknown, _tenantId: string, grantId: string, reason: string | null, act: () => Promise<unknown>) => {
    const r = await act();
    grantAudits.push({ grantId, reason });
    return r;
  },
  auditedConfigAct: async (_tx: unknown, _actor: unknown, _tenantId: string, configId: string, action: string, _reason: unknown, act: () => Promise<unknown>) => {
    const r = await act();
    configAudits.push({ configId, action });
    return r;
  },
}));
let deliverable = true;
vi.mock('./group-fulfilment', async (original) => ({
  ...(await original<object>()),
  deliverableGroupIds: async (_tx: unknown, ids: string[]) => new Set(deliverable ? ids : []),
}));
const roomAsked: string[] = [];
let onPlatform: Record<string, boolean> = {};
vi.mock('../entitlement/reseller-room', async (original) => ({ ...(await original<object>()), assertPlatformGrantRoom: async (_tx: unknown, groupId: string) => void roomAsked.push(groupId) }));
vi.mock('./vpn-wholesale', async (original) => ({ ...(await original<object>()), onPlatformPanel: async (_tx: unknown, groupId: string) => onPlatform[groupId] ?? false }));

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const GRANT = '33333333-3333-4333-8333-333333333333';
const [P1, P2, P3] = ['a', 'b', 'f'].map((x) => `${x.repeat(8)}-${x.repeat(4)}-4${x.repeat(3)}-8${x.repeat(3)}-${x.repeat(12)}`);
const [EU, GAMING] = ['c', 'd'].map((x) => `${x.repeat(8)}-${x.repeat(4)}-4${x.repeat(3)}-8${x.repeat(3)}-${x.repeat(12)}`);

const inbound = (remoteId: string, over: { share?: number | null; groupClients?: number } = {}) => ({
  remoteId,
  protocol: ConfigProtocol.vless,
  maxClients: null,
  share: over.share ?? null,
  clients: 10,
  groupClients: over.groupClients ?? 0,
});
const member = (panelId: string, inbounds: ReturnType<typeof inbound>[], over: Partial<MemberFacts['panel']> & { role?: PanelGroupMemberRole } = {}): MemberFacts => ({
  panelId,
  role: over.role ?? PanelGroupMemberRole.primary,
  panel: {
    reviewState: PanelReviewState.accepted,
    panelState: PanelState.healthy,
    driftEvents: [],
    inboundPlacement: InboundPlacement.all,
    maxClients: null,
    groupMaxClients: over.groupMaxClients ?? null,
    inboundsPerBuyer: 1,
    users: 5,
    groupUsers: over.groupUsers ?? 0,
    inbounds,
  },
});

describe('splitForTarget — which configs keep their link', () => {
  const configs = [
    { id: 'on-shared', panelId: P1, inboundRemoteId: '3' },
    { id: 'on-own', panelId: P1, inboundRemoteId: '7' },
    { id: 'elsewhere', panelId: P2, inboundRemoteId: '3' },
  ];

  it('keeps a config whose inbound the target sells on that panel, moves the rest', () => {
    const { kept, moved, full } = splitForTarget(configs, [member(P1, [inbound('3')])]);
    expect(kept.map((c) => c.id)).toEqual(['on-shared']);
    expect(moved.map((c) => c.id)).toEqual(['on-own', 'elsewhere']);
    expect(full).toBe(false);
  });

  it('moves a config off a member the target is draining', () => {
    const { kept } = splitForTarget(configs, [member(P1, [inbound('3')], { role: PanelGroupMemberRole.drain })]);
    expect(kept).toEqual([]);
  });

  it('a row placed before inbounds were picked stays on any member panel of the target', () => {
    const { kept } = splitForTarget([{ id: 'legacy', panelId: P1, inboundRemoteId: null }], [member(P1, [])]);
    expect(kept.map((c) => c.id)).toEqual(['legacy']);
  });

  it('is full when a kept config finds the target\'s share of its inbound taken', () => {
    expect(splitForTarget(configs, [member(P1, [inbound('3', { share: 4, groupClients: 4 })])]).full).toBe(true);
    expect(splitForTarget(configs, [member(P1, [inbound('3', { share: 4, groupClients: 3 })])]).full).toBe(false);
  });

  it('is full when the target\'s member cap on that panel is taken', () => {
    expect(splitForTarget(configs, [member(P1, [inbound('3')], { groupMaxClients: 2, groupUsers: 2 })]).full).toBe(true);
  });
});

type Row = Record<string, unknown>;

function harness(over: { grant?: Row; target?: MemberFacts[]; placeAfter?: number; groupTenant?: string | null; unpricedMeters?: number; tenantType?: TenantType } = {}) {
  grantAudits.length = 0;
  configAudits.length = 0;
  roomAsked.length = 0;
  deliverable = true;
  onPlatform = {};
  const grant: Row = { id: GRANT, tenantId: TENANT, status: GrantStatus.active, panelGroupId: EU, ...over.grant };
  const configs: Row[] = [
    { id: 'c-shared', grantId: GRANT, panelId: P1, inboundRemoteId: '3', live: true },
    { id: 'c-own', grantId: GRANT, panelId: P2, inboundRemoteId: '5', live: true },
  ];
  const drained: string[] = [];
  const fulfilled: string[] = [];
  const tx = {
    grant: {
      findUnique: async () => grant,
      update: async ({ data }: { data: Row }) => Object.assign(grant, data),
    },
    panelGroup: { findUnique: async ({ where }: { where: Row }) => (where.id === GAMING ? { id: GAMING, tenantId: over.groupTenant === undefined ? null : over.groupTenant } : null) },
    grantMeter: { count: async () => over.unpricedMeters ?? 0 },
    tenant: { findUnique: async () => ({ tenantType: over.tenantType ?? TenantType.reseller }) },
    config: {
      findMany: async () => configs.filter((c) => c.live).map(({ id, panelId, inboundRemoteId }) => ({ id, panelId, inboundRemoteId })),
      count: async () => configs.filter((c) => c.live).length,
    },
  };
  const actions = {
    drain: vi.fn(async (_tx: unknown, { configId }: { configId: string }) => {
      drained.push(configId);
      (configs.find((c) => c.id === configId) as Row).live = false;
    }),
  };
  const fulfilment = {
    membersOf: vi.fn(async () => over.target ?? [member(P1, [inbound('3')]), member(P3, [inbound('9')])]),
    fulfil: vi.fn(async (_tx: unknown, grantId: string) => {
      fulfilled.push(grantId);
      for (let i = 0; i < (over.placeAfter ?? 1); i += 1) configs.push({ id: `new-${i}`, grantId, panelId: P3, inboundRemoteId: '9', live: true });
      return { placed: over.placeAfter ?? 1, waiting: [], activated: false };
    }),
  };
  const acts = new GrantRegroupActs(actions as never, fulfilment as never);
  const input: RegroupInput = { grantId: GRANT, toGroupId: GAMING, actor: { userId: 'admin', ip: '203.0.113.7' }, reason: 'gaming plan', bounded: false };
  const regroup = (more: Partial<RegroupInput> = {}) => acts.regroup(tx as never, { ...input, ...more });
  return { grant, configs, drained, fulfilled, regroup, fulfilment };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof GrantRegroupRefused) return e.reason;
    throw e;
  }
  return 'none';
};

describe('GrantRegroupActs.regroup — one Grant to another group', () => {
  it('changes the group, keeps the shared config, moves the other, and writes it down', async () => {
    const h = harness();
    const done = await h.regroup();
    expect(done).toEqual({ grantId: GRANT, fromGroupId: EU, toGroupId: GAMING, kept: 1, moved: 1 });
    expect(h.grant.panelGroupId).toBe(GAMING);
    expect(h.drained).toEqual(['c-own']);
    expect(configAudits).toEqual([{ configId: 'c-own', action: 'config_move' }]);
    expect(h.fulfilled).toEqual([GRANT]);
    expect(grantAudits).toEqual([{ grantId: GRANT, reason: 'gaming plan' }]);
  });

  it('is no_target, and rolls back, when the user would be left with no line', async () => {
    const h = harness({ target: [member(P3, [inbound('9')])], placeAfter: 0 });
    expect(await refusal(h.regroup())).toBe('no_target');
  });

  it('a pending Grant with nothing placed yet just changes group', async () => {
    const h = harness({ grant: { status: GrantStatus.pending }, placeAfter: 0 });
    h.configs.length = 0;
    expect((await h.regroup()).moved).toBe(0);
    expect(h.grant.panelGroupId).toBe(GAMING);
  });

  it('refuses before writing: same group, no group, foreign group, undeliverable, full share', async () => {
    expect(await refusal(harness().regroup({ toGroupId: EU }))).toBe('same_group');
    expect(await refusal(harness({ grant: { panelGroupId: null } }).regroup())).toBe('grant_not_movable');
    expect(await refusal(harness({ grant: { status: GrantStatus.expired } }).regroup())).toBe('grant_not_movable');
    expect(await refusal(harness({ groupTenant: OTHER_TENANT }).regroup())).toBe('group_not_for_grant');
    expect(await refusal(harness().regroup({ toGroupId: P2 }))).toBe('group_not_found');
    const undeliverable = harness();
    deliverable = false;
    expect(await refusal(undeliverable.regroup())).toBe('target_not_deliverable');
    const full = harness({ target: [member(P1, [inbound('3', { share: 1, groupClients: 1 })])] });
    expect(await refusal(full.regroup())).toBe('target_full');
    expect(full.grant.panelGroupId).toBe(EU);
    expect(full.drained).toEqual([]);
  });

  it('asks the reseller\'s platform room only when bounded and moving onto a platform panel', async () => {
    const h = harness();
    onPlatform = { [GAMING]: true };
    await h.regroup({ bounded: true });
    expect(roomAsked).toEqual([GAMING]);

    const already = harness();
    onPlatform = { [EU]: true, [GAMING]: true };
    await already.regroup({ bounded: true });
    expect(roomAsked).toEqual([]);

    const owner = harness();
    onPlatform = { [GAMING]: true };
    await owner.regroup({ bounded: false });
    expect(roomAsked).toEqual([]);
  });

  it('refuses a reseller\'s Grant sold with no wholesale leg a move onto a platform panel, and nothing else (F-118-n7)', async () => {
    const unpriced = harness({ unpricedMeters: 1 });
    onPlatform = { [GAMING]: true };
    expect(await refusal(unpriced.regroup())).toBe('wholesale_rate_missing');
    expect(unpriced.grant.panelGroupId).toBe(EU);
    expect(unpriced.drained).toEqual([]);

    const ownPanels = harness({ unpricedMeters: 1 });
    expect((await ownPanels.regroup()).toGroupId).toBe(GAMING);

    const platformsOwn = harness({ unpricedMeters: 1, tenantType: TenantType.platform_owner });
    onPlatform = { [GAMING]: true };
    expect((await platformsOwn.regroup()).toGroupId).toBe(GAMING);
  });
});
