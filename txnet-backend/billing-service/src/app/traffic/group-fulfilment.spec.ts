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
 *  - **an unbuilt strategy is refused**, never treated as `mirror`.
 */
import { ActorType, ConfigStatus, DesiredRemote, EnforcementState, GrantStatus, PanelGroupMemberRole, PanelGroupStrategy, PanelReviewState, PanelState, Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { ConfigActionsService } from './config-actions';
import { GroupFulfilmentService, planFulfilment } from './group-fulfilment';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999991';
const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map((x) => `${x.repeat(8)}-${x.repeat(4)}-4${x.repeat(3)}-8${x.repeat(3)}-${x.repeat(12)}`);

type Row = Record<string, unknown> & { id: string };
type Member = { panelId: string; role: PanelGroupMemberRole; panel: { reviewState: PanelReviewState; panelState: PanelState } };

const member = (panelId: string, panelState: PanelState = PanelState.healthy, role: PanelGroupMemberRole = PanelGroupMemberRole.primary, reviewState: PanelReviewState = PanelReviewState.accepted): Member => ({
  panelId,
  role,
  panel: { reviewState, panelState },
});

function build(opts: { status?: GrantStatus; strategy?: PanelGroupStrategy; minHealthyPanels?: number; members: Member[] }) {
  const grant = { id: GRANT, tenantId: TENANT, userId: USER, status: opts.status ?? GrantStatus.pending };
  const group = { id: 'group-1', strategy: opts.strategy ?? PanelGroupStrategy.mirror, minHealthyPanels: opts.minHealthyPanels ?? 1, protocol: 'vless', members: opts.members };
  const configs: Row[] = [];
  const rebalanced: string[] = [];
  const outbox: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let next = 0;

  const tx = {
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
      findMany: async ({ where }: { where: { grantId: string } }) => configs.filter((c) => c.grantId === where.grantId),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: `config-${++next}`, status: ConfigStatus.active, ...data };
        configs.push(row);
        return row;
      },
    },
    configActionLog: { create: async ({ data }: { data: Record<string, unknown> }) => data },
    outboxEvent: { create: async ({ data }: { data: { type: string; payload: Record<string, unknown> } }) => void outbox.push(data) },
  };

  const allocator = {
    rebalance: async (_tx: unknown, input: { grantId: string }) => {
      rebalanced.push(input.grantId);
      return {};
    },
  };
  const service = new GroupFulfilmentService(new ConfigActionsService(allocator as never), {} as never, {} as never);
  return { service, tx: tx as unknown as Prisma.TransactionClient, grant, group, configs, rebalanced, outbox };
}

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
    expect(configs.every((c) => c.protocol === 'vless' && c.desiredRemote === DesiredRemote.present && c.userId === USER)).toBe(true);
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
      grantStatus: GrantStatus.pending,
      group: { strategy: PanelGroupStrategy.mirror, minHealthyPanels: 1, members: [member(B), member(A, PanelState.maintenance)] },
      configs: [{ panelId: B, status: ConfigStatus.active, desiredRemote: DesiredRemote.present, enforcementState: EnforcementState.pending, credentialGroupId: 'g', drainedAt: null }],
    };
    expect(planFulfilment(facts)).toEqual({ place: [], waiting: [A], activate: false, credentialGroupId: 'g' });
    expect(planFulfilment({ ...facts, group: { ...facts.group, members: [...facts.group.members].reverse() } })).toEqual(planFulfilment(facts));
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
