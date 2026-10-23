/**
 * The old login waits for the new one (ADR-0160 decision 11, F-1601-d2). What
 * would break silently, and nowhere else:
 *
 *  - **a move cut the user off at once**: the old row was retired in the same
 *    write that made the new one, before the target had even built it, and a
 *    user who typed a login or copied a config by hand lost service until they
 *    changed their device. It now serves until the new row is confirmed on its
 *    panel, plus {@link MOVE_GRACE_DAYS} days, and the user is told when;
 *  - **moves in a row stacked live configs**: one old row waits per config, so
 *    moving the new one again retires the one still waiting;
 *  - **a row on its way out moved again** would fork the chain: refused.
 */
import { ActorType, ConfigProtocol, ConfigStatus, DesiredRemote, EnforcementState, InboundPlacement, PanelReviewState, PanelState, Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { GRANT_AGGREGATE } from '../entitlement/delivered';
import type { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { ConfigActionsService } from './config-actions';
import { MOVE_GRACE_DAYS, MOVE_HANDOFF_ACTOR } from './move-handoff';
import { MoveHandoffService, type HandoffRow } from './move-handoff.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999991';
const [P1, P2, P3] = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'];
const ADMIN = { actorType: ActorType.admin, actorId: '33333333-3333-4333-8333-333333333333' };
const DAY_MS = 86_400_000;

type Row = Record<string, unknown> & { id: string };

/** `where` as Prisma reads it, for the few shapes these writes use: equality, `{ not }`, and null. */
const matches = (row: Row, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => (v !== null && typeof v === 'object' && 'not' in v ? row[k] !== (v as { not: unknown }).not : (row[k] ?? null) === v));

function store() {
  const configs: Row[] = [];
  const logs: { configId: string; actorId: string; action: string }[] = [];
  const outbox: { type: string; payload: Record<string, unknown> }[] = [];
  let next = 0;
  const panel = (id: string) => ({
    id,
    tenantId: TENANT,
    retiredAt: null,
    reviewState: PanelReviewState.accepted,
    panelState: PanelState.healthy,
    driftEvents: [],
    inboundPlacement: InboundPlacement.all,
    maxClients: null,
    inboundsPerBuyer: null,
    inbounds: [{ remoteId: '1', protocol: ConfigProtocol.vless, maxClients: null }],
  });
  const tx = {
    $executeRaw: async () => 1,
    grant: { findUnique: async () => ({ id: GRANT, tenantId: TENANT, userId: USER, status: 'active', trafficUnlimited: false, panelGroupId: null }) },
    panel: { findUnique: async ({ where }: { where: { id: string } }) => panel(where.id) },
    panelGroupMember: { findUnique: async () => null },
    config: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = { id: `config-${++next}`, status: ConfigStatus.active, regenerateUsedCount: 0, maxRegenerateCount: 3, supersededById: null, retireAt: null, ...data };
        configs.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => configs.find((c) => c.id === where.id) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => configs.filter((c) => matches(c, where)),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = configs.filter((c) => matches(c, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
    configActionLog: { create: async ({ data }: { data: { configId: string; actorId: string; action: string } }) => logs.push(data) },
    outboxEvent: { create: async ({ data }: { data: { type: string; payload: Record<string, unknown> } }) => outbox.push(data) },
  };
  // The target sells `vless`: a move keeps the protocol and makes one row (decision 10).
  const crossTenant = { $queryRaw: async () => [] } as unknown as CrossTenantPrismaService;
  const actions = new ConfigActionsService(null, crossTenant);
  return { actions, tx: tx as unknown as Prisma.TransactionClient, raw: tx, configs, logs, outbox };
}

async function provisioned(s: ReturnType<typeof store>, panelId = P1) {
  return (await s.actions.provision(s.tx, { grantId: GRANT, panelId, protocol: ConfigProtocol.vless, actor: ADMIN })).configId;
}

describe('a move keeps the old row serving until the new one is confirmed (ADR-0160 decision 11)', () => {
  it('leaves the old row live, present and pointing at its replacement; the move is logged on it', async () => {
    const s = store();
    const old = await provisioned(s);

    const moved = await s.actions.move(s.tx, { configId: old, toPanelId: P2, actor: ADMIN });

    expect(s.configs.find((c) => c.id === old)).toMatchObject({ status: ConfigStatus.active, desiredRemote: DesiredRemote.present, desiredEnabled: true, supersededById: moved.configId, retireAt: null });
    expect(s.configs.find((c) => c.id === moved.configId)).toMatchObject({ panelId: P2, supersededById: null });
    expect(moved.retiredConfigId).toBe(old);
    // The self-move wait still counts from the move itself (F-410-b).
    expect(s.logs.filter((l) => l.configId === old).map((l) => l.action)).toEqual(['provision', 'move_out']);
  });

  it('keeps one old row waiting: moving the new one again retires the one still waiting', async () => {
    const s = store();
    const first = await provisioned(s);
    const second = (await s.actions.move(s.tx, { configId: first, toPanelId: P2, actor: ADMIN })).configId;

    const third = (await s.actions.move(s.tx, { configId: second, toPanelId: P3, actor: ADMIN })).configId;

    expect(s.configs.find((c) => c.id === first)).toMatchObject({ status: ConfigStatus.retired, desiredRemote: DesiredRemote.absent });
    expect(s.logs).toContainEqual(expect.objectContaining({ configId: first, actorId: MOVE_HANDOFF_ACTOR.actorId }));
    expect(s.configs.find((c) => c.id === second)).toMatchObject({ status: ConfigStatus.active, supersededById: third });
  });

  it('refuses to move a row already on its way out', async () => {
    const s = store();
    const old = await provisioned(s);
    await s.actions.move(s.tx, { configId: old, toPanelId: P2, actor: ADMIN });

    await expect(s.actions.move(s.tx, { configId: old, toPanelId: P3, actor: ADMIN })).rejects.toMatchObject({ name: 'ConfigActionRefused', reason: 'config_leaving' });
  });
});

describe('the handoff sweep', () => {
  const NOW = new Date('2026-10-23T12:00:00Z');

  async function moving() {
    const s = store();
    const old = await provisioned(s);
    const moved = await s.actions.move(s.tx, { configId: old, toPanelId: P2, actor: ADMIN });
    const due: HandoffRow[] = [];
    const crossTenant = { $queryRaw: async () => due };
    const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(s.raw) };
    const sweep = new MoveHandoffService(s.actions, prisma as never, crossTenant as never);
    sweep.now = () => NOW;
    s.outbox.length = 0;
    const row = (over: Partial<HandoffRow>): HandoffRow => ({ id: old, tenantId: TENANT, userId: USER, grantId: GRANT, retireAt: null, confirmed: true, replacementGone: false, ...over });
    return { s, old, newId: moved.configId, due, sweep, row };
  }

  it('starts the grace once the replacement is confirmed, and tells the user once, as a cutoff', async () => {
    const { s, old, due, sweep, row } = await moving();
    due.push(row({}));

    expect(await sweep.handoffDue()).toMatchObject({ scanned: 1, told: 1, retired: 0, failed: 0 });

    expect(s.configs.find((c) => c.id === old)).toMatchObject({ status: ConfigStatus.active, retireAt: new Date(NOW.getTime() + MOVE_GRACE_DAYS * DAY_MS) });
    expect(s.outbox).toEqual([
      { aggregate: GRANT_AGGREGATE, aggregateId: GRANT, type: OutboxEventType.GRANT_CONFIG_MOVE_READY, payload: { tenantId: TENANT, userId: USER, grantId: GRANT, period: old, days: String(MOVE_GRACE_DAYS) } },
    ]);
    // A row already told is not told again, however often the scan names it.
    expect(await sweep.handoffDue()).toMatchObject({ told: 0 });
    expect(s.outbox).toHaveLength(1);
  });

  it('retires the old row when the grace is over, and the open page re-reads', async () => {
    const { s, old, due, sweep, row } = await moving();
    due.push(row({ retireAt: new Date(NOW.getTime() - 1) }));

    expect(await sweep.handoffDue()).toMatchObject({ retired: 1, told: 0 });

    expect(s.configs.find((c) => c.id === old)).toMatchObject({ status: ConfigStatus.retired, desiredRemote: DesiredRemote.absent, enforcementState: EnforcementState.pending });
    expect(s.logs).toContainEqual(expect.objectContaining({ configId: old, actorId: MOVE_HANDOFF_ACTOR.actorId, action: 'retire' }));
    expect(s.outbox).toEqual([expect.objectContaining({ type: OutboxEventType.GRANT_LINKS_CAPTURED, payload: { tenantId: TENANT, userId: USER, grantId: GRANT, cause: 'move_handoff' } })]);
  });

  it('retires the old row at once when its replacement is gone before it was confirmed', async () => {
    const { s, old, due, sweep, row } = await moving();
    due.push(row({ confirmed: false, replacementGone: true }));

    expect(await sweep.handoffDue()).toMatchObject({ retired: 1 });
    expect(s.configs.find((c) => c.id === old)?.status).toBe(ConfigStatus.retired);
  });
});
