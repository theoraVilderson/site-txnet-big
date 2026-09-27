/**
 * Group fulfilment — a Grant of a variant with a panel group gets one config on
 * every non-drain healthy member, all sharing one `credentialGroupId`, and the
 * Grant activates once `minHealthyPanels` of them are confirmed on a serving
 * panel (F-027-bl, network `contract.groups.md`). What would break silently:
 *
 *  - **one config per panel, however often it runs.** The job is at-least-once
 *    and a panel can die mid-provisioning; a second pass that created again
 *    would hand the user two clients on one panel and split the bag three ways;
 *  - **a member that was down is filled when it is healthy again**, under the
 *    same `credentialGroupId`, and one that is `drain` never is;
 *  - **activation is a read of the panel, never of our write**: only a
 *    `complete` config on a panel still serving counts towards the minimum;
 *  - **an unbuilt strategy is refused**, never treated as `mirror`;
 *  - **a config goes only on an inbound the panel's admin picked** (F-114-b,
 *    `contract.inbounds.md`): every pick under `all`, the emptiest under
 *    `spread`, none past an inbound's or the panel's cap, and nothing at all —
 *    never the first enabled inbound — on a panel with no pick;
 *  - **under `hrw`, K of the picks by the Grant's rendezvous hash** (F-027-di):
 *    a lost inbound moves nobody until its config is gone, and then only that
 *    buyer, to its next-ranked inbound.
 */
import { ActorType, ConfigProtocol, ConfigStatus, DesiredRemote, EnforcementState, GrantStatus, InboundPlacement, PanelGroupMemberRole, PanelGroupStrategy, PanelReviewState, PanelState, Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { ConfigActionsService } from './config-actions';
import { GroupFulfilmentService, planFulfilment } from './group-fulfilment';
import { hrwPick } from './hrw';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999991';
const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map((x) => `${x.repeat(8)}-${x.repeat(4)}-4${x.repeat(3)}-8${x.repeat(3)}-${x.repeat(12)}`);

type Row = Record<string, unknown> & { id: string };
type Inbound = { remoteId: string; protocol: ConfigProtocol; maxClients: number | null };
type PanelOpts = { inboundPlacement?: InboundPlacement; maxClients?: number | null; inboundsPerBuyer?: number | null; inbounds?: Inbound[] };
type Member = {
  panelId: string;
  role: PanelGroupMemberRole;
  inboundPlacement?: InboundPlacement | null;
  maxClients?: number | null;
  inboundsPerBuyer?: number | null;
  /** Assigned inbounds (F-027-ch); none = the panel's pool, `panel.inbounds`. */
  inbounds: { inbound: Inbound & { enabled: boolean; goneAt: Date | null } }[];
  panel: { reviewState: PanelReviewState; panelState: PanelState; inboundPlacement: InboundPlacement; maxClients: number | null; inboundsPerBuyer: number | null; inbounds: Inbound[] };
};

const inbound = (remoteId: string, protocol: ConfigProtocol = ConfigProtocol.vless, maxClients: number | null = null): Inbound => ({ remoteId, protocol, maxClients });

/** One picked vless inbound, `1`, unless the panel says otherwise. */
const member = (
  panelId: string,
  panelState: PanelState = PanelState.healthy,
  role: PanelGroupMemberRole = PanelGroupMemberRole.primary,
  reviewState: PanelReviewState = PanelReviewState.accepted,
  panel: PanelOpts = {},
): Member => ({
  panelId,
  role,
  inbounds: [],
  panel: { reviewState, panelState, inboundPlacement: panel.inboundPlacement ?? InboundPlacement.all, maxClients: panel.maxClients ?? null, inboundsPerBuyer: panel.inboundsPerBuyer ?? null, inbounds: panel.inbounds ?? [inbound('1')] },
});
const on = (panelId: string, panel: PanelOpts) => member(panelId, PanelState.healthy, PanelGroupMemberRole.primary, PanelReviewState.accepted, panel);

function build(opts: { status?: GrantStatus; strategy?: PanelGroupStrategy; minHealthyPanels?: number; members: Member[]; others?: Row[] }) {
  const grant = { id: GRANT, tenantId: TENANT, userId: USER, status: opts.status ?? GrantStatus.pending };
  const group = { id: 'group-1', strategy: opts.strategy ?? PanelGroupStrategy.mirror, minHealthyPanels: opts.minHealthyPanels ?? 1, members: opts.members };
  const configs: Row[] = [];
  /** Other buyers' configs: they fill inbounds and panels, and are never this Grant's. */
  const others: Row[] = opts.others ?? [];
  const rebalanced: string[] = [];
  const outbox: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const locked: string[] = [];
  let next = 0;

  const tx = {
    $executeRaw: async (_s: TemplateStringsArray, key: string) => void locked.push(key),
    grant: {
      findUnique: async ({ where, select }: { where: { id: string }; select: Record<string, unknown> }) =>
        where.id === GRANT ? { ...grant, ...('variant' in select ? { variant: { panelGroup: group } } : {}) } : null,
      updateMany: async ({ where, data }: { where: { id: string; status: GrantStatus }; data: { status: GrantStatus } }) => {
        if (where.id !== GRANT || where.status !== grant.status) return { count: 0 };
        grant.status = data.status;
        return { count: 1 };
      },
    },
    config: {
      findMany: async ({ where }: { where: { grantId: string } }) => configs.filter((c) => c.grantId === where.grantId).map((c) => ({ inboundRemoteId: null, drainedAt: null, ...c })),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: `config-${++next}`, status: ConfigStatus.active, ...data };
        configs.push(row);
        return row;
      },
    },
    configActionLog: { create: async ({ data }: { data: Record<string, unknown> }) => data },
    outboxEvent: { create: async ({ data }: { data: { type: string; payload: Record<string, unknown> } }) => void outbox.push(data) },
  };

  // The load query, answered from the rows: per (panel, inbound) and per panel, live configs only.
  const crossTenant = {
    grant: {
      findFirst: async ({ where }: { where: { id: string; status: GrantStatus } }) =>
        where.id === GRANT && where.status === grant.status ? { id: GRANT, tenantId: TENANT } : null,
    },
    $queryRaw: async (_s: TemplateStringsArray, panelIds: string[]) => {
      const live = [...configs, ...others].filter((c) => panelIds.includes(c.panelId as string) && c.desiredRemote === DesiredRemote.present && !c.drainedAt);
      const rows: Record<string, unknown>[] = [];
      for (const panelId of new Set(live.map((c) => c.panelId as string))) {
        const mine = live.filter((c) => c.panelId === panelId);
        rows.push({ panelId, inboundRemoteId: null, total: 1, clients: BigInt(mine.length), users: BigInt(new Set(mine.map((c) => c.grantId)).size) });
        for (const id of new Set(mine.map((c) => (c.inboundRemoteId as string | null) ?? null))) {
          const n = mine.filter((c) => (c.inboundRemoteId ?? null) === id);
          rows.push({ panelId, inboundRemoteId: id, total: 0, clients: BigInt(n.length), users: BigInt(new Set(n.map((c) => c.grantId)).size) });
        }
      }
      return rows;
    },
  };

  const allocator = {
    rebalance: async (_tx: unknown, input: { grantId: string }) => {
      rebalanced.push(input.grantId);
      return {};
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  const service = new GroupFulfilmentService(new ConfigActionsService(allocator as never), prisma as never, crossTenant as never);
  return { service, tx: tx as unknown as Prisma.TransactionClient, grant, group, configs, rebalanced, outbox, locked };
}

/** A member as `planFulfilment` takes it: loaded, nobody on it yet. */
const withLoad = (m: Member) => ({ ...m, panel: { ...m.panel, users: 0, inbounds: m.panel.inbounds.map((i) => ({ ...i, clients: 0 })) } });

/** Another buyer's live config on (panel, inbound). */
const taken = (panelId: string, inboundRemoteId: string, grantId = `other-${panelId}-${inboundRemoteId}-${Math.random()}`): Row => ({
  id: `o-${grantId}`, grantId, panelId, inboundRemoteId, desiredRemote: DesiredRemote.present, drainedAt: null,
});

describe('GroupFulfilmentService.fulfil (mirror)', () => {
  it('places one config on every non-drain healthy accepted member, all in one credential group', async () => {
    const { service, tx, configs, rebalanced } = build({
      members: [
        member(A),
        member(B, PanelState.healthy, PanelGroupMemberRole.replica),
        member(C, PanelState.healthy, PanelGroupMemberRole.drain),
        member(D, PanelState.down),
        member(E, PanelState.healthy, PanelGroupMemberRole.primary, PanelReviewState.pending),
      ],
    });

    const result = await service.fulfil(tx, GRANT);

    expect(configs.map((c) => c.panelId)).toEqual([A, B]);
    expect(new Set(configs.map((c) => c.credentialGroupId)).size).toBe(1);
    expect(configs[0].credentialGroupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(configs.every((c) => c.protocol === 'vless' && c.inboundRemoteId === '1' && c.desiredRemote === DesiredRemote.present && c.userId === USER)).toBe(true);
    // A pending Grant is provisioned: it activates on what the panels confirm.
    expect(result).toMatchObject({ placed: 2, waiting: [D, E], activated: false });
    // Once for the whole placement, so every new config has its share before the pass creates it.
    expect(rebalanced).toEqual([GRANT]);
  });

  it('is convergent: a second run places nothing, and a member healthy again is filled in the same group', async () => {
    const members = [member(A), member(B, PanelState.down)];
    const { service, tx, configs, group } = build({ members });

    await service.fulfil(tx, GRANT);
    // A killed mid-provisioning: its row is still pending, and it is not made twice.
    group.members = [member(A, PanelState.down), member(B, PanelState.down)];
    expect((await service.fulfil(tx, GRANT)).placed).toBe(0);

    group.members = [member(A), member(B)];
    expect((await service.fulfil(tx, GRANT)).placed).toBe(1);
    expect((await service.fulfil(tx, GRANT)).placed).toBe(0);

    expect(configs.map((c) => c.panelId)).toEqual([A, B]);
    expect(configs[1].credentialGroupId).toBe(configs[0].credentialGroupId);
  });

  it('never refills a panel whose config of the group was retired: a retire is a decision, not a gap', async () => {
    const { service, tx, configs } = build({ members: [member(A)] });
    await service.fulfil(tx, GRANT);
    configs[0].status = ConfigStatus.retired;
    configs[0].desiredRemote = DesiredRemote.absent;

    expect((await service.fulfil(tx, GRANT)).placed).toBe(0);
    expect(configs).toHaveLength(1);
  });

  it('places again on a panel re-added after a drain: the drain\'s retire is not the user\'s decision (F-027-bp)', async () => {
    const { service, tx, configs } = build({ members: [member(A), member(B)] });
    await service.fulfil(tx, GRANT);
    // A was drained and removed; the member is back, as primary.
    Object.assign(configs[0], { status: ConfigStatus.retired, desiredRemote: DesiredRemote.absent, drainedAt: new Date() });

    expect((await service.fulfil(tx, GRANT)).placed).toBe(1);
    expect(configs.map((c) => [c.panelId, c.status])).toEqual([[A, ConfigStatus.retired], [B, ConfigStatus.active], [A, ConfigStatus.active]]);
    expect(configs[2].credentialGroupId).toBe(configs[1].credentialGroupId);
    expect((await service.fulfil(tx, GRANT)).placed).toBe(0);
  });

  it('activates a pending Grant only at minHealthyPanels complete configs on serving panels', async () => {
    const { service, tx, grant, group, configs, outbox } = build({ minHealthyPanels: 2, members: [member(A), member(B), member(C)] });
    await service.fulfil(tx, GRANT);

    configs[0].enforcementState = EnforcementState.complete;
    expect((await service.fulfil(tx, GRANT)).activated).toBe(false);
    expect(grant.status).toBe(GrantStatus.pending);

    // Confirmed, but on a panel that has since gone down: it does not count.
    configs[1].enforcementState = EnforcementState.complete;
    group.members = [member(A), member(B, PanelState.down), member(C)];
    expect((await service.fulfil(tx, GRANT)).activated).toBe(false);

    // A panel refusing our admin calls still serves its users.
    group.members = [member(A), member(B, PanelState.throttled_or_blocked), member(C)];
    expect((await service.fulfil(tx, GRANT)).activated).toBe(true);
    expect(grant.status).toBe(GrantStatus.active);
    // Delivered once, and the buyer is told (F-111-d).
    expect(outbox.map((e) => [e.type, e.payload['grantId']])).toEqual([[OutboxEventType.GRANT_DELIVERED, GRANT]]);
    expect((await service.fulfil(tx, GRANT)).activated).toBe(false);
    expect(outbox).toHaveLength(1);
  });

  it('refuses a strategy with no fulfilment behind it, and a Grant that no longer carries service', async () => {
    for (const strategy of [PanelGroupStrategy.priority, PanelGroupStrategy.weighted]) {
      const { service, tx, configs } = build({ strategy, members: [member(A)] });
      await expect(service.fulfil(tx, GRANT)).rejects.toEqual(expect.objectContaining({ name: 'GroupFulfilmentRefused', reason: 'strategy_not_built' }));
      expect(configs).toHaveLength(0);
    }

    const suspended = build({ status: GrantStatus.suspended, members: [member(A)] });
    await expect(suspended.service.fulfil(suspended.tx, GRANT)).rejects.toEqual(expect.objectContaining({ reason: 'grant_not_fulfillable' }));
    expect(suspended.configs).toHaveLength(0);
  });

  it('answers the same plan from the same facts, whatever order the members come in', () => {
    const facts = {
      grantId: GRANT,
      grantStatus: GrantStatus.pending,
      group: { strategy: PanelGroupStrategy.mirror, minHealthyPanels: 1, members: [member(B), member(A, PanelState.maintenance)].map(withLoad) },
      configs: [{ panelId: B, inboundRemoteId: '1', status: ConfigStatus.active, desiredRemote: DesiredRemote.present, enforcementState: EnforcementState.pending, credentialGroupId: 'g', drainedAt: null }],
    };
    expect(planFulfilment(facts)).toEqual({ place: [], waiting: [A], activate: false, credentialGroupId: 'g' });
    expect(planFulfilment({ ...facts, group: { ...facts.group, members: [...facts.group.members].reverse() } })).toEqual(planFulfilment(facts));
  });
});

describe('placement on the picked inbounds (F-114-b)', () => {
  it('places nothing on a panel with no pick — never the first enabled inbound — and waits for one', async () => {
    const { service, tx, configs, group } = build({ members: [on(A, { inbounds: [] }), member(B)] });

    const result = await service.fulfil(tx, GRANT);
    expect(configs.map((c) => [c.panelId, c.inboundRemoteId])).toEqual([[B, '1']]);
    expect(result.waiting).toEqual([A]);

    // The admin picks one: the next run fills it, in the same credential group.
    group.members = [on(A, { inbounds: [inbound('7', ConfigProtocol.trojan)] }), member(B)];
    expect((await service.fulfil(tx, GRANT)).placed).toBe(1);
    expect(configs[1]).toMatchObject({ panelId: A, inboundRemoteId: '7', protocol: ConfigProtocol.trojan, credentialGroupId: configs[0].credentialGroupId });
  });

  it('under `all`, a config on every pick, each with its inbound\'s protocol; a pick added later reaches existing buyers', async () => {
    const { service, tx, configs, group } = build({ members: [on(A, { inbounds: [inbound('2', ConfigProtocol.vmess), inbound('10'), inbound('1')] })] });

    await service.fulfil(tx, GRANT);
    expect(configs.map((c) => [c.inboundRemoteId, c.protocol])).toEqual([['1', 'vless'], ['2', 'vmess'], ['10', 'vless']]);
    expect((await service.fulfil(tx, GRANT)).placed).toBe(0);

    group.members = [on(A, { inbounds: [inbound('1'), inbound('2', ConfigProtocol.vmess), inbound('10'), inbound('11', ConfigProtocol.trojan)] })];
    expect((await service.fulfil(tx, GRANT)).placed).toBe(1);
    expect(configs[3]).toMatchObject({ inboundRemoteId: '11', protocol: 'trojan' });
  });

  it('a member with assigned inbounds is placed on those, never on the pool (F-027-ch)', async () => {
    const own = { ...inbound('7', ConfigProtocol.trojan), enabled: true, goneAt: null };
    const { service, tx, configs } = build({ members: [{ ...on(A, { inbounds: [inbound('1')] }), inbounds: [{ inbound: own }] }] });

    await service.fulfil(tx, GRANT);
    expect(configs.map((c) => [c.inboundRemoteId, c.protocol])).toEqual([['7', 'trojan']]);
  });

  it('under `spread`, one config, on the emptiest pick with a seat', async () => {
    const others = [taken(A, '1'), taken(A, '1'), taken(A, '2'), taken(A, '3'), taken(A, '3')];
    const panel = { inboundPlacement: InboundPlacement.spread, inbounds: [inbound('1'), inbound('2', ConfigProtocol.vless, 1), inbound('3')] };
    const { service, tx, configs } = build({ members: [on(A, panel)], others });

    // 2 is the emptiest but full at its cap of 1; 1 and 3 tie at two, and 1 sorts first.
    await service.fulfil(tx, GRANT);
    expect(configs.map((c) => c.inboundRemoteId)).toEqual(['1']);
    expect((await service.fulfil(tx, GRANT)).placed).toBe(0);
  });

  it('a full inbound takes nobody; a full panel takes no new buyer, and still fills in one it holds', async () => {
    const full = build({ members: [on(A, { inbounds: [inbound('1', ConfigProtocol.vless, 2), inbound('2')] })], others: [taken(A, '1'), taken(A, '1')] });
    await full.service.fulfil(full.tx, GRANT);
    expect(full.configs.map((c) => c.inboundRemoteId)).toEqual(['2']);

    const others = [taken(A, '1', 'g1'), taken(A, '1', 'g2')];
    const capped = build({ members: [on(A, { maxClients: 2 })], others });
    expect(await capped.service.fulfil(capped.tx, GRANT)).toMatchObject({ placed: 0, waiting: [A] });

    const held = build({ members: [on(A, { maxClients: 1 })], others: [] });
    await held.service.fulfil(held.tx, GRANT);
    held.group.members = [on(A, { maxClients: 1, inbounds: [inbound('1'), inbound('5')] })];
    expect((await held.service.fulfil(held.tx, GRANT)).placed).toBe(1);
  });

  it('places by the member\'s own placement and cap over its panel\'s, and by the panel\'s where the member sets none (F-027-cg)', async () => {
    const others = [taken(A, '1', 'g1')];
    const panel = { inboundPlacement: InboundPlacement.spread, maxClients: 1, inbounds: [inbound('1'), inbound('2')] };
    const overridden = build({ members: [{ ...on(A, panel), inboundPlacement: InboundPlacement.all, maxClients: 5 }], others });
    await overridden.service.fulfil(overridden.tx, GRANT);
    expect(overridden.configs.map((c) => c.inboundRemoteId)).toEqual(['1', '2']);

    const inherited = build({ members: [{ ...on(A, panel), inboundPlacement: null, maxClients: null }], others });
    expect(await inherited.service.fulfil(inherited.tx, GRANT)).toMatchObject({ placed: 0, waiting: [A] });
  });

  it('under `hrw`, K of the picks, the ones the Grant\'s rendezvous hash names; K defaults to 2 (F-027-di)', async () => {
    const picks = ['1', '2', '3', '4', '5', '6'].map((id) => inbound(id));
    const ranked = hrwPick(GRANT, picks.map((i) => ({ id: i.remoteId, weight: 1, healthy: true, full: false })), 6, true);
    const { service, tx, configs } = build({ members: [on(A, { inboundPlacement: InboundPlacement.hrw, inbounds: picks })] });

    await service.fulfil(tx, GRANT);
    expect(configs.map((c) => c.inboundRemoteId).sort()).toEqual(ranked.slice(0, 2).sort());
    expect((await service.fulfil(tx, GRANT)).placed).toBe(0);

    const three = build({ members: [{ ...on(A, { inboundPlacement: InboundPlacement.hrw, inboundsPerBuyer: 5, inbounds: picks }), inboundsPerBuyer: 3 }] });
    await three.service.fulfil(three.tx, GRANT);
    expect(three.configs.map((c) => c.inboundRemoteId).sort()).toEqual(ranked.slice(0, 3).sort());
  });

  it('under `hrw`, a lost inbound moves nobody while its config stands, then only its buyer, to the next-ranked pick', async () => {
    const picks = ['1', '2', '3', '4', '5'].map((id) => inbound(id));
    const ranked = hrwPick(GRANT, picks.map((i) => ({ id: i.remoteId, weight: 1, healthy: true, full: false })), 5, true);
    const hrw = (inbounds: Inbound[]) => [on(A, { inboundPlacement: InboundPlacement.hrw, inbounds })];
    const { service, tx, configs, group } = build({ members: hrw(picks) });
    await service.fulfil(tx, GRANT);
    for (const c of configs) c.desiredRemote = DesiredRemote.present;

    // Its first inbound is disabled: the config there still holds one of the two (SPEC weakness #25).
    const lost = ranked[0];
    group.members = hrw(picks.filter((i) => i.remoteId !== lost));
    expect((await service.fulfil(tx, GRANT)).placed).toBe(0);

    // The platform drains it: exactly one new config, on the third-ranked, never on the one it keeps.
    const gone = configs.find((c) => c.inboundRemoteId === lost);
    if (gone) gone.drainedAt = new Date();
    expect((await service.fulfil(tx, GRANT)).placed).toBe(1);
    expect(configs.at(-1)).toMatchObject({ inboundRemoteId: ranked[2], credentialGroupId: configs[0].credentialGroupId });
  });

  it('under `hrw`, a full inbound is passed over for the next, and fewer picks than K place on each and owe no more', async () => {
    const picks = ['1', '2', '3'].map((id) => inbound(id, ConfigProtocol.vless, 1));
    const ranked = hrwPick(GRANT, picks.map((i) => ({ id: i.remoteId, weight: 1, healthy: true, full: false })), 3, true);
    const full = build({ members: [on(A, { inboundPlacement: InboundPlacement.hrw, inbounds: picks })], others: [taken(A, ranked[0])] });
    await full.service.fulfil(full.tx, GRANT);
    expect(full.configs.map((c) => c.inboundRemoteId)).toEqual(ranked.slice(1, 3).sort());

    const few = build({ members: [on(A, { inboundPlacement: InboundPlacement.hrw, inboundsPerBuyer: 4, inbounds: [inbound('1')] })] });
    await few.service.fulfil(few.tx, GRANT);
    expect(await few.service.fulfil(few.tx, GRANT)).toMatchObject({ placed: 0, waiting: [] });
  });

  it('a config placed before picks holds its panel, and counts once towards minHealthyPanels', async () => {
    const legacy = build({ members: [on(A, { inbounds: [inbound('1'), inbound('2')] })] });
    legacy.configs.push({ id: 'old', grantId: GRANT, panelId: A, inboundRemoteId: null, status: ConfigStatus.active, desiredRemote: DesiredRemote.present, credentialGroupId: 'g' });
    expect((await legacy.service.fulfil(legacy.tx, GRANT)).placed).toBe(0);

    const two = build({ minHealthyPanels: 2, members: [on(A, { inbounds: [inbound('1'), inbound('2')] }), member(B)] });
    await two.service.fulfil(two.tx, GRANT);
    for (const c of two.configs.filter((c) => c.panelId === A)) c.enforcementState = EnforcementState.complete;
    expect((await two.service.fulfil(two.tx, GRANT)).activated).toBe(false);
  });

  it('takes each placeable panel\'s lock before counting, in panel order', async () => {
    const { service, tx, locked } = build({ members: [member(B), member(C, PanelState.down), member(A)] });
    await service.fulfil(tx, GRANT);
    expect(locked).toEqual([`panel_inbound:${A}`, `panel_inbound:${B}`]);
  });
});

describe('the system actor', () => {
  it('is logged as system, not as the user the Grant belongs to', async () => {
    const { service, tx } = build({ members: [member(A)] });
    const logs: Record<string, unknown>[] = [];
    (tx as unknown as { configActionLog: { create: (a: { data: Record<string, unknown> }) => unknown } }).configActionLog.create = async ({ data }) => logs.push(data);
    await service.fulfil(tx, GRANT);
    expect(logs).toEqual([expect.objectContaining({ actorType: ActorType.system, action: 'provision' })]);
  });
});

describe('GroupFulfilmentService.fulfilNow — a config confirmed (F-111-n)', () => {
  const confirmed = (panelId: string): Row => ({
    id: `c-${panelId}`, grantId: GRANT, panelId, status: ConfigStatus.active, desiredRemote: DesiredRemote.present,
    enforcementState: EnforcementState.complete, credentialGroupId: 'cg-1', inboundRemoteId: '1',
  });

  it('activates a pending Grant the moment its panels have confirmed it, without waiting for the sweep', async () => {
    const { service, grant, configs, outbox } = build({ members: [member(A)] });
    configs.push(confirmed(A));
    expect(await service.fulfilNow(GRANT)).toBe('activated');
    expect(grant.status).toBe(GrantStatus.active);
    expect(outbox.map((e) => e.type)).toContain(OutboxEventType.GRANT_DELIVERED);
  });

  it('leaves a Grant short of minHealthyPanels waiting', async () => {
    const { service, grant, configs } = build({ minHealthyPanels: 2, members: [member(A), member(B)] });
    configs.push(confirmed(A));
    expect(await service.fulfilNow(GRANT)).toBe('waiting');
    expect(grant.status).toBe(GrantStatus.pending);
  });

  it('skips a Grant that is no longer pending — a repeat, a cancel or a gift touches nothing', async () => {
    const { service, configs } = build({ status: GrantStatus.active, members: [member(A)] });
    expect(await service.fulfilNow(GRANT)).toBe('skipped');
    expect(configs).toHaveLength(0);
  });
});
