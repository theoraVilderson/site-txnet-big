/**
 * Draining a panel group member — `role = drain` takes no new Grants, and its
 * configs are deleted only once no client can still be holding a subscription
 * that names them (F-027-bm, network `contract.groups.md`). What would break
 * silently:
 *
 *  - **a user cut off by the drain.** `/sub` drops a drain line only once the
 *    Grant has another line it serves, so the 2 × TTL wait is counted from the
 *    later of the drain and that replacement's capture — not from the drain
 *    alone — and a Grant with no replacement keeps its drain config;
 *  - **the member removed while a config is still on it**, which would leave a
 *    client on a panel no group governs;
 *  - **an un-drain meanwhile overwritten**: the removal is conditional on
 *    `role = drain` at the moment of the delete;
 *  - **a dead panel kept forever** (F-027-ee): an evicted member — the owner
 *    chose "remove now" — goes on the next sweep, held Grants and all, with no
 *    wait; a Grant with no other line is the owner's stated cost, not a hold;
 *  - **an orphan's days lost or its money kept** (F-027-eg): a Grant an evict
 *    leaves with no line is paused — the clock stopped, its lines retired in
 *    the same transaction — or cancelled with its unused share refunded, as
 *    the owner chose; a failed one is retried whole, never half done. A paused
 *    one comes back on its own once its group has a healthy member again.
 */
import { ConfigStatus, GrantStatus, Prisma } from '@prisma/client';

import { ConfigActionsService } from './config-actions';
import { DrainConfig, GroupDrainService, planDrain } from './group-drain';

const TTL = 3600;
const HOUR = 3600_000;
const SINCE = new Date('2026-09-24T00:00:00Z');
const at = (hours: number) => new Date(SINCE.getTime() + hours * HOUR);

const drainConfig = (configId: string, over: Partial<DrainConfig> = {}): DrainConfig => ({
  configId,
  grantId: `grant-${configId}`,
  tenantId: 'tenant-1',
  grantStatus: GrantStatus.active,
  replacementSince: at(-5),
  ...over,
});

describe('planDrain', () => {
  it('retires an active Grant\'s config 2 × TTL after the drain when its replacement was already served', () => {
    const facts = { drainingSince: SINCE, subscriptionTtlSeconds: TTL, configs: [drainConfig('c1')] };
    expect(planDrain(facts, at(1.99)).retire).toEqual([]);
    expect(planDrain(facts, at(2)).retire.map((c) => c.configId)).toEqual(['c1']);
  });

  it('counts the wait from the replacement\'s capture when it came after the drain', () => {
    // /sub kept the drain line until the replacement was served, at +3h.
    const facts = { drainingSince: SINCE, subscriptionTtlSeconds: TTL, configs: [drainConfig('c1', { replacementSince: at(3) })] };
    expect(planDrain(facts, at(4.99)).retire).toEqual([]);
    expect(planDrain(facts, at(5)).retire.map((c) => c.configId)).toEqual(['c1']);
  });

  it('holds an active Grant with no served replacement, and keeps the member', () => {
    const facts = { drainingSince: SINCE, subscriptionTtlSeconds: TTL, configs: [drainConfig('c1', { replacementSince: null }), drainConfig('c2')] };
    const plan = planDrain(facts, at(48));
    expect(plan.retire.map((c) => c.configId)).toEqual(['c2']);
    expect(plan.held).toEqual(['grant-c1']);
    expect(plan.removeMember).toBe(false);
  });

  it('retires a Grant /sub serves nothing of without a replacement, after the same wait', () => {
    const facts = {
      drainingSince: SINCE,
      subscriptionTtlSeconds: TTL,
      configs: [drainConfig('c1', { grantStatus: GrantStatus.expired, replacementSince: null }), drainConfig('c2', { grantStatus: GrantStatus.pending, replacementSince: null })],
    };
    expect(planDrain(facts, at(1)).retire).toEqual([]);
    const plan = planDrain(facts, at(2));
    expect(plan.retire.map((c) => c.configId)).toEqual(['c1', 'c2']);
    expect(plan.removeMember).toBe(true);
  });

  it('retires everything of an evicted member at once, a Grant with no replacement included, and removes it', () => {
    const facts = {
      drainingSince: SINCE,
      subscriptionTtlSeconds: TTL,
      evicted: true,
      configs: [drainConfig('c1', { replacementSince: null }), drainConfig('c2', { replacementSince: at(0.5) })],
    };
    const plan = planDrain(facts, at(0.01));
    expect(plan.retire.map((c) => c.configId)).toEqual(['c1', 'c2']);
    expect(plan.held).toEqual([]);
    expect(plan.removeMember).toBe(true);
  });

  it('removes a member with nothing left on it once its wait is over', () => {
    expect(planDrain({ drainingSince: SINCE, subscriptionTtlSeconds: TTL, configs: [] }, at(1)).removeMember).toBe(false);
    expect(planDrain({ drainingSince: SINCE, subscriptionTtlSeconds: TTL, configs: [] }, at(2)).removeMember).toBe(true);
  });
});

describe('GroupDrainService.drainDue', () => {
  function build(configs: DrainConfig[], opts: { failRetire?: string; evicted?: boolean; orphans?: 'pause' | 'refund'; failOrphan?: string; waiting?: { id: string; tenantId: string }[]; memberTenant?: string } = {}) {
    const statements: string[] = [];
    // Each outbox row with what had been removed when it was written: the removal's own transaction carries it (RT-1-f).
    const announced: { payload: unknown; afterRemove: boolean }[] = [];
    const retired: string[] = [];
    const crossTenant = {
      $queryRaw: async (sql: TemplateStringsArray) => {
        const text = sql.join('?');
        statements.push(text);
        if (text.includes('"awaitingPanel"')) return opts.waiting ?? [];
        if (text.includes('"drainingSince" +')) {
          const evicted = opts.evicted ?? false;
          return [{ groupId: 'group-1', panelId: 'panel-d', tenantId: opts.memberTenant ?? null, drainingSince: SINCE, subscriptionTtlSeconds: TTL, evicted,
            evictOrphans: evicted ? (opts.orphans ?? 'pause') : null, evictedBy: evicted ? 'admin-1' : null }];
        }
        return configs;
      },
      $executeRaw: async (sql: TemplateStringsArray) => {
        const text = sql.join('?');
        statements.push(text);
        // No panel here was deleted in one step: the archive finds none.
        return text.includes('"removeRequestedAt"') ? 0 : 1;
      },
      tenant: { findFirst: async () => ({ id: 'platform-1' }) },
      outboxEvent: {
        create: async ({ data }: { data: { type: string; payload: unknown } }) => {
          if (data.type !== 'network.panel.drained') throw new Error(`unexpected outbox type ${data.type}`);
          announced.push({ payload: data.payload, afterRemove: statements.some((t) => t.startsWith('DELETE')) });
          return {};
        },
      },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(crossTenant),
    };
    const rows = new Map(configs.map((c) => [c.configId, { id: c.configId, tenantId: c.tenantId, userId: 'u', grantId: c.grantId, panelId: 'panel-d', protocol: 'vless', status: ConfigStatus.active }]));
    const tx = {
      $executeRaw: async () => 1,
      config: {
        findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
        updateMany: async ({ where, data }: { where: { id: string }; data: { status?: ConfigStatus; drainedAt?: Date } }) => {
          if (where.id === opts.failRetire) return { count: 0 };
          // Marked as the drain's, so a re-added member is placed again (F-027-bp).
          if (data.status !== ConfigStatus.retired || !(data.drainedAt instanceof Date)) throw new Error(`not a drain retire: ${JSON.stringify(data)}`);
          retired.push(where.id);
          return { count: 1 };
        },
      },
      configActionLog: { create: async () => ({}) },
    };
    const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
    const service = new GroupDrainService(new ConfigActionsService(), prisma as never, crossTenant as never, {} as never);
    service.now = () => at(10);
    // Each orphan handler runs in the transaction that retired the Grant's lines: what it saw retired is recorded with it.
    const orphaned: string[] = [];
    const resumed: string[] = [];
    service.orphans = {
      pause: async (_tx, grantId) => {
        if (grantId === opts.failOrphan) throw new Error('grant moved');
        orphaned.push(`pause ${grantId} after ${retired.join(',')}`);
      },
      refund: async (_tx, grantId, _at, actorUserId) => {
        orphaned.push(`refund ${grantId} by ${actorUserId}`);
      },
      resume: async (_tx, grantId) => {
        resumed.push(grantId);
      },
    };
    return { service, statements, retired, orphaned, resumed, announced, tx: tx as unknown as Prisma.TransactionClient };
  }

  it('retires the due configs, then removes the member only while it is still draining and bare', async () => {
    const { service, statements, retired } = build([drainConfig('c1'), drainConfig('c2')]);
    const result = await service.drainDue();

    expect(retired).toEqual(['c1', 'c2']);
    expect(result).toEqual({ scanned: 1, configsRetired: 2, grantsHeld: 0, membersRemoved: 1, failed: 0, grantsPaused: 0, grantsRefunded: 0, grantsResumed: 0, panelsArchived: 0 });
    const remove = statements.find((s) => s.startsWith('DELETE'))!;
    expect(remove).toContain(`"role" = 'drain'`);
    expect(remove).toContain(`c."status" <> 'retired'`);
  });

  it('keeps the member when a Grant is held or a retire failed', async () => {
    const held = build([drainConfig('c1', { replacementSince: null }), drainConfig('c2')]);
    expect(await held.service.drainDue()).toMatchObject({ scanned: 1, configsRetired: 1, grantsHeld: 1, membersRemoved: 0, failed: 0 });
    expect(held.statements.some((s) => s.startsWith('DELETE'))).toBe(false);

    const failing = build([drainConfig('c1'), drainConfig('c2')], { failRetire: 'c1' });
    expect(await failing.service.drainDue()).toMatchObject({ scanned: 1, configsRetired: 1, grantsHeld: 0, membersRemoved: 0, failed: 1 });
    expect(failing.statements.some((s) => s.startsWith('DELETE'))).toBe(false);
  });

  it('takes an evicted member as due before its wait, and retires its held Grant too (F-027-ee)', async () => {
    const { service, statements, retired } = build([drainConfig('c1', { replacementSince: null })], { evicted: true });
    service.now = () => at(0.01);
    expect(await service.drainDue()).toMatchObject({ scanned: 1, configsRetired: 1, grantsHeld: 0, membersRemoved: 1, failed: 0, grantsPaused: 1 });
    expect(retired).toEqual(['c1']);
    expect(statements.find((t) => t.includes('"drainingSince" +'))).toContain('"evictedAt" IS NOT NULL');
  });

  it('pauses a Grant an evict leaves with no line, in the transaction that retired its lines; a Grant with another line is only retired (F-027-eg)', async () => {
    const { service, retired, orphaned } = build(
      [drainConfig('c1', { grantId: 'g-orphan', replacementSince: null }), drainConfig('c2', { grantId: 'g-orphan', replacementSince: null }), drainConfig('c3')],
      { evicted: true, orphans: 'pause' },
    );
    expect(await service.drainDue()).toMatchObject({ configsRetired: 3, grantsPaused: 1, grantsRefunded: 0, membersRemoved: 1, failed: 0 });
    expect(retired.sort()).toEqual(['c1', 'c2', 'c3']);
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]).toMatch(/^pause g-orphan after .*c1.*c2|^pause g-orphan after .*c2.*c1/);
  });

  it('cancels it with its unused share refunded instead, named as the owner who evicted', async () => {
    const { service, orphaned } = build([drainConfig('c1', { grantId: 'g-orphan', replacementSince: null })], { evicted: true, orphans: 'refund' });
    expect(await service.drainDue()).toMatchObject({ grantsPaused: 0, grantsRefunded: 1, membersRemoved: 1 });
    expect(orphaned).toEqual(['refund g-orphan by admin-1']);
  });

  it('a Grant whose pause failed keeps its lines and the member, to be tried whole on the next tick', async () => {
    const { service, orphaned } = build([drainConfig('c1', { grantId: 'g-orphan', replacementSince: null })], { evicted: true, orphans: 'pause', failOrphan: 'g-orphan' });
    expect(await service.drainDue()).toMatchObject({ configsRetired: 0, grantsPaused: 0, membersRemoved: 0, failed: 1 });
    expect(orphaned).toEqual([]);
  });

  it('a plain drain never pauses or refunds: its Grant with no line is held', async () => {
    const { service, orphaned } = build([drainConfig('c1', { replacementSince: null })]);
    expect(await service.drainDue()).toMatchObject({ grantsHeld: 1, grantsPaused: 0, grantsRefunded: 0 });
    expect(orphaned).toEqual([]);
  });

  it('resumes the paused Grants whose group has a healthy member again, before draining', async () => {
    const { service, resumed, statements } = build([], { waiting: [{ id: 'g-1', tenantId: 'tenant-1' }, { id: 'g-2', tenantId: 'tenant-2' }] });
    expect(await service.drainDue()).toMatchObject({ grantsResumed: 2 });
    expect(resumed).toEqual(['g-1', 'g-2']);
    const scan = statements.find((s) => s.includes('"awaitingPanel"'))!;
    expect(scan).toContain(`p."panelState" = 'healthy'`);
    expect(scan).toContain(`m."role" <> 'drain'`);
  });

  it('archives a panel removed in one step only once its clients are gone from it, or an hour after the ask (F-027-eg)', async () => {
    const { service, statements } = build([]);
    await service.drainDue();
    const archive = statements.find((t) => t.includes('"removeRequestedAt"'))!;
    expect(archive).toContain('SET "retiredAt"');
    expect(archive).toContain('NOT EXISTS (SELECT 1 FROM "network"."panel_group_member"');
    expect(archive).toContain(`c."status" <> 'retired'`);
    expect(archive).toContain('c."remoteId" IS NOT NULL');
    expect(archive).toContain("interval '1 hour'");
  });

  it('tells the member\'s tenant\'s open systems page once per pass that retired or removed, in the removal\'s transaction (RT-1-f)', async () => {
    const removed = build([drainConfig('c1'), drainConfig('c2')], { memberTenant: 'reseller-1' });
    await removed.service.drainDue();
    expect(removed.announced).toEqual([{ payload: { tenantId: 'reseller-1', panelId: 'panel-d', groupId: 'group-1' }, afterRemove: true }]);

    // A platform group's member names no tenant: the platform's page hears it.
    const partial = build([drainConfig('c1', { replacementSince: null }), drainConfig('c2')]);
    await partial.service.drainDue();
    expect(partial.announced).toEqual([{ payload: { tenantId: 'platform-1', panelId: 'panel-d', groupId: 'group-1' }, afterRemove: false }]);

    // Nothing moved — every Grant held: the page has nothing to re-read.
    const held = build([drainConfig('c1', { replacementSince: null })]);
    await held.service.drainDue();
    expect(held.announced).toEqual([]);
  });
});
