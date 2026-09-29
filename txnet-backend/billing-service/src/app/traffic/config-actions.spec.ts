/**
 * Config actions — every one is a write to desired state, and none calls a
 * panel (F-027-z, ADR-0075). `network-service`'s convergence pass is the only
 * code that reaches a panel; what would break silently here, and nowhere else:
 *
 *  - **a delete is not a purge.** Both write `desiredRemote = absent`, and only
 *    `status = retired` tells the top-up that revives a Grant to leave a
 *    deleted config alone (`config_retired_is_absent` holds the pair);
 *  - **a move is a new row.** The old row retires and a new one is created on
 *    the target panel — a row that changed `panelId` would compare the new
 *    panel's counter against the old panel's cursor;
 *  - **the regenerate limit is enforced where the count moves**, in the
 *    write's own `where`, so two concurrent regenerates cannot both pass a
 *    check made before either wrote (invariant 4).
 * No action sizes a share: that is the lease planner's (F-027-db, F-027-dk).
 */
import { ActorType, ConfigStatus, DesiredRemote, EnforcementState, GrantStatus, Prisma } from '@prisma/client';

import { UsageDoorRefused, type UsageDoorService } from '../usage/usage-door';
import { ConfigActionRefused, ConfigActionsService } from './config-actions';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999991';
const PANEL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PANEL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_TENANT_PANEL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ADMIN = { actorType: ActorType.admin, actorId: '33333333-3333-4333-8333-333333333333' };
const OWNER = { actorType: ActorType.user, actorId: USER };

type Row = Record<string, unknown> & { id: string };

function matches(row: Row, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, want]) => row[key] === want);
}

function build(grantStatus: GrantStatus = GrantStatus.active, trafficUnlimited = false, door: UsageDoorService | null = null) {
  const configs: Row[] = [];
  const logs: Row[] = [];
  let next = 0;

  const tx = {
    // A Grant is sold with a regenerate meter only when a door is given.
    grantMeter: { findUnique: async () => (door ? { id: 'meter-1' } : null) },
    grant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === GRANT ? { id: GRANT, tenantId: TENANT, userId: USER, status: grantStatus, trafficUnlimited } : null,
    },
    panel: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        ({
          [PANEL_A]: { id: PANEL_A, tenantId: null },
          [PANEL_B]: { id: PANEL_B, tenantId: TENANT },
          [OTHER_TENANT_PANEL]: { id: OTHER_TENANT_PANEL, tenantId: '44444444-4444-4444-8444-444444444444' },
        })[where.id] ?? null,
    },
    config: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: `config-${++next}`,
          status: ConfigStatus.active,
          desiredEnabled: true,
          desiredRemote: DesiredRemote.present,
          enforcementState: EnforcementState.pending,
          regenerateUsedCount: 0,
          maxRegenerateCount: 3,
          remoteId: null,
          ...data,
        };
        configs.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => configs.find((c) => c.id === where.id) ?? null,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = configs.filter((c) => matches(c, where));
        for (const row of hit) {
          for (const [key, value] of Object.entries(data)) {
            row[key] =
              value !== null && typeof value === 'object' && 'increment' in value ? (row[key] as number) + (value as { increment: number }).increment : value;
          }
        }
        return { count: hit.length };
      },
    },
    configActionLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `log-${logs.length + 1}`, ...data };
        logs.push(row);
        return row;
      },
    },
  };

  const service = new ConfigActionsService(door);
  return { service, tx: tx as unknown as Prisma.TransactionClient, configs, logs };
}

const refusal = (reason: string) => expect.objectContaining({ name: 'ConfigActionRefused', reason });

describe('ConfigActionsService', () => {
  it('provisions a row the loop will create', async () => {
    const { service, tx, configs, logs } = build();

    const made = await service.provision(tx, { grantId: GRANT, panelId: PANEL_A, protocol: 'vless', actor: OWNER });

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      tenantId: TENANT,
      userId: USER,
      grantId: GRANT,
      panelId: PANEL_A,
      protocol: 'vless',
      uuid: made.uuid,
      desiredRemote: DesiredRemote.present,
      desiredEnabled: true,
      remoteId: null,
    });
    expect(made.uuid).toMatch(/^[0-9a-f-]{36}$/);
    // The second matching key (F-027-aa): without it a rename on the panel
    // orphans the usage. Ours, global, and never the credential.
    expect(configs[0].claimTag).toMatch(/^txn-[0-9a-f]{32}$/);
    expect(configs[0].claimTag).not.toContain(made.uuid.replace(/-/g, ''));
    expect(logs).toEqual([expect.objectContaining({ configId: made.configId, action: 'provision', actorType: ActorType.user })]);
  });

  it("copies an unlimited Grant's flag onto every config it makes, one by one or by a group (F-111-r)", async () => {
    const limited = build();
    await limited.service.provision(limited.tx, { grantId: GRANT, panelId: PANEL_A, protocol: 'vless', actor: OWNER });
    expect(limited.configs[0].trafficUnlimited).toBe(false);

    const { service, tx, configs } = build(GrantStatus.pending, true);
    await service.provisionForGroup(tx, {
      grantId: GRANT,
      credentialGroupId: '55555555-5555-4555-8555-555555555555',
      placements: [
        { panelId: PANEL_A, protocol: 'vless', inboundRemoteId: '1' },
        { panelId: PANEL_B, protocol: 'vless', inboundRemoteId: '2' },
      ],
      actor: ADMIN,
    });
    expect(configs.map((c) => c.trafficUnlimited)).toEqual([true, true]);
  });

  it('refuses a Grant that cannot carry service, and a panel another tenant owns', async () => {
    const suspended = build(GrantStatus.suspended);
    await expect(suspended.service.provision(suspended.tx, { grantId: GRANT, panelId: PANEL_A, protocol: 'vless', actor: OWNER })).rejects.toEqual(
      refusal('grant_not_active'),
    );

    const { service, tx, configs } = build();
    await expect(service.provision(tx, { grantId: GRANT, panelId: OTHER_TENANT_PANEL, protocol: 'vless', actor: OWNER })).rejects.toEqual(
      refusal('panel_not_found'),
    );
    expect(configs).toHaveLength(0);
  });

  it('regenerates by writing a new uuid, and stops at the limit in the write itself', async () => {
    const { service, tx, configs } = build();
    const { configId, uuid } = await service.provision(tx, { grantId: GRANT, panelId: PANEL_A, protocol: 'vless', actor: OWNER });
    configs[0].enforcementState = EnforcementState.complete;

    const first = await service.regenerate(tx, { configId, actor: OWNER });
    expect(first.uuid).not.toBe(uuid);
    expect(configs[0]).toMatchObject({ uuid: first.uuid, regenerateUsedCount: 1, enforcementState: EnforcementState.pending });
    // The tag is the config's, not the credential's: a regenerate keeps it.
    const tag = configs[0].claimTag;

    await service.regenerate(tx, { configId, actor: OWNER });
    await service.regenerate(tx, { configId, actor: OWNER });
    await expect(service.regenerate(tx, { configId, actor: OWNER })).rejects.toEqual(refusal('regenerate_limit_reached'));
    expect(configs[0].regenerateUsedCount).toBe(3);
    expect(configs[0].claimTag).toBe(tag);
  });

  it("an admin's regenerate is outside the user's cap: it neither checks nor spends it (F-311-g)", async () => {
    const { service, tx, configs, logs } = build();
    const { configId, uuid } = await service.provision(tx, { grantId: GRANT, panelId: PANEL_A, protocol: 'vless', actor: OWNER });
    configs[0].regenerateUsedCount = 3;

    const done = await service.regenerate(tx, { configId, actor: ADMIN });

    expect(done.uuid).not.toBe(uuid);
    expect(configs[0]).toMatchObject({ uuid: done.uuid, regenerateUsedCount: 3, enforcementState: EnforcementState.pending });
    expect(logs.at(-1)).toMatchObject({ actorType: ActorType.admin, action: 'regenerate' });
    // The user's own is still refused at the cap.
    await expect(service.regenerate(tx, { configId, actor: OWNER })).rejects.toEqual(refusal('regenerate_limit_reached'));
  });

  it('a priced regenerate goes through the door instead of the cap: authorized before, committed after, cancelled if refused (F-118-h)', async () => {
    const calls: string[] = [];
    let refuse: UsageDoorRefused | null = null;
    const door = {
      authorize: async () => {
        if (refuse) throw refuse;
        calls.push('authorize');
        return { token: 'tok' };
      },
      commit: async (_tx: unknown, i: { token: string; quantity: bigint }) => void calls.push(`commit ${i.token} ${i.quantity}`),
      cancel: async (_tx: unknown, i: { token: string }) => void calls.push(`cancel ${i.token}`),
    } as unknown as UsageDoorService;
    const { service, tx, configs } = build(GrantStatus.active, false, door);
    const { configId } = await service.provision(tx, { grantId: GRANT, panelId: PANEL_A, protocol: 'vless', actor: OWNER });
    configs[0].regenerateUsedCount = 3;

    await service.regenerate(tx, { configId, actor: OWNER });
    expect(calls).toEqual(['authorize', 'commit tok 1']);
    expect(configs[0].regenerateUsedCount).toBe(3);

    refuse = new UsageDoorRefused('insufficient_funds');
    await expect(service.regenerate(tx, { configId, actor: OWNER })).rejects.toMatchObject({ reason: 'regenerate_unfunded' });
    refuse = new UsageDoorRefused('not_metered_past_included');
    await expect(service.regenerate(tx, { configId, actor: OWNER })).rejects.toMatchObject({ reason: 'regenerate_limit_reached' });

    refuse = null;
    calls.length = 0;
    configs[0].status = ConfigStatus.disabled_by_admin;
    const read = tx.config.findUnique.bind(tx.config);
    (tx.config as unknown as { findUnique: unknown }).findUnique = async (args: { where: { id: string } }) => ({ ...((await read(args as never)) as Row), status: ConfigStatus.active });
    await expect(service.regenerate(tx, { configId, actor: OWNER })).rejects.toEqual(refusal('config_changed'));
    expect(calls).toEqual(['authorize', 'cancel tok']);
  });

  it('a regenerate that lost the race to another write is refused, not applied twice', async () => {
    const { service, tx, configs } = build();
    const { configId } = await service.provision(tx, { grantId: GRANT, panelId: PANEL_A, protocol: 'vless', actor: OWNER });
    const read = tx.config.findUnique.bind(tx.config);
    // Another regenerate commits between this one's read and its write.
    (tx.config as unknown as { findUnique: unknown }).findUnique = async (args: { where: { id: string } }) => {
      const seen = { ...((await read(args as never)) as Row) };
      configs[0].regenerateUsedCount = (configs[0].regenerateUsedCount as number) + 1;
      return seen;
    };

    await expect(service.regenerate(tx, { configId, actor: OWNER })).rejects.toEqual(refusal('config_changed'));
    expect(configs[0].regenerateUsedCount).toBe(1);
  });

  it('disables and enables through desired state, and enabling a suspended Grant leaves it off', async () => {
    const { service, tx, configs, logs } = build();
    const { configId } = await service.provision(tx, { grantId: GRANT, panelId: PANEL_A, protocol: 'vless', actor: OWNER });

    await service.disable(tx, { configId, reason: 'abuse report', actor: ADMIN });
    expect(configs[0]).toMatchObject({ status: ConfigStatus.disabled_by_admin, desiredEnabled: false, disabledReason: 'abuse report' });

    await service.enable(tx, { configId, actor: ADMIN });
    expect(configs[0]).toMatchObject({ status: ConfigStatus.active, desiredEnabled: true, disabledReason: null });
    expect(logs.map((l) => l.action)).toEqual(['provision', 'disable', 'enable']);

    const suspended = build(GrantStatus.suspended);
    suspended.configs.push({ id: 'c-s', grantId: GRANT, status: ConfigStatus.disabled_by_admin, desiredEnabled: false, desiredRemote: DesiredRemote.present });
    await suspended.service.enable(suspended.tx, { configId: 'c-s', actor: ADMIN });
    expect(suspended.configs[0]).toMatchObject({ status: ConfigStatus.active, desiredEnabled: false });
  });

  it('a user cannot disable a config — only delete it', async () => {
    const { service, tx } = build();
    const { configId } = await service.provision(tx, { grantId: GRANT, panelId: PANEL_A, protocol: 'vless', actor: OWNER });
    await expect(service.disable(tx, { configId, reason: 'x', actor: OWNER })).rejects.toEqual(refusal('actor_not_allowed'));
  });

  it('deletes by retiring the row, never by removing it', async () => {
    const { service, tx, configs } = build();
    const { configId } = await service.provision(tx, { grantId: GRANT, panelId: PANEL_A, protocol: 'vless', actor: OWNER });
    configs[0].remoteId = 'remote-7';

    await service.retire(tx, { configId, actor: OWNER });

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      status: ConfigStatus.retired,
      desiredRemote: DesiredRemote.absent,
      desiredEnabled: false,
      enforcementState: EnforcementState.pending,
      // Cleared by the loop once the panel confirms the delete, never here.
      remoteId: 'remote-7',
    });
    await expect(service.enable(tx, { configId, actor: ADMIN })).rejects.toEqual(refusal('config_retired'));
    await expect(service.regenerate(tx, { configId, actor: OWNER })).rejects.toEqual(refusal('config_retired'));
  });

  it('moves by retiring the old row and creating a new one on the target panel', async () => {
    const { service, tx, configs } = build();
    const { configId, uuid } = await service.provision(tx, { grantId: GRANT, panelId: PANEL_A, protocol: 'vless', actor: OWNER });

    const moved = await service.move(tx, { configId, toPanelId: PANEL_B, actor: ADMIN });

    expect(moved.retiredConfigId).toBe(configId);
    expect(configs).toHaveLength(2);
    expect(configs[0]).toMatchObject({ panelId: PANEL_A, status: ConfigStatus.retired, desiredRemote: DesiredRemote.absent });
    expect(configs[1]).toMatchObject({ id: moved.configId, panelId: PANEL_B, grantId: GRANT, protocol: 'vless', desiredRemote: DesiredRemote.present });
    // `uuid` is unique across the system, and the old client holds the old one until it is deleted.
    expect(configs[1].uuid).not.toBe(uuid);
    expect(configs[1].claimTag).not.toBe(configs[0].claimTag);

    await expect(service.move(tx, { configId: moved.configId, toPanelId: PANEL_B, actor: ADMIN })).rejects.toEqual(refusal('same_panel'));
    await expect(service.move(tx, { configId, toPanelId: PANEL_B, actor: ADMIN })).rejects.toEqual(refusal('config_retired'));
  });

  it('refuses an unknown config with a typed reason', async () => {
    const { service, tx } = build();
    await expect(service.retire(tx, { configId: 'nope', actor: OWNER })).rejects.toBeInstanceOf(ConfigActionRefused);
    // Another user's config reads as absent, never as someone else's.
    const { configId } = await service.provision(tx, { grantId: GRANT, panelId: PANEL_A, protocol: 'vless', actor: OWNER });
    const stranger = { actorType: ActorType.user, actorId: '55555555-5555-4555-8555-555555555555' };
    await expect(service.retire(tx, { configId, actor: stranger })).rejects.toEqual(refusal('config_not_found'));
  });
});
