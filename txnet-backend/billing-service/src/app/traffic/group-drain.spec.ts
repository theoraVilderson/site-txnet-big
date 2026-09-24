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
 *    `role = drain` at the moment of the delete.
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

  it('removes a member with nothing left on it once its wait is over', () => {
    expect(planDrain({ drainingSince: SINCE, subscriptionTtlSeconds: TTL, configs: [] }, at(1)).removeMember).toBe(false);
    expect(planDrain({ drainingSince: SINCE, subscriptionTtlSeconds: TTL, configs: [] }, at(2)).removeMember).toBe(true);
  });
});

describe('GroupDrainService.drainDue', () => {
  function build(configs: DrainConfig[], opts: { failRetire?: string } = {}) {
    const statements: string[] = [];
    const retired: string[] = [];
    const crossTenant = {
      $queryRaw: async (sql: TemplateStringsArray) => {
        const text = sql.join('?');
        statements.push(text);
        if (text.includes('"drainingSince" +')) {
          return [{ groupId: 'group-1', panelId: 'panel-d', drainingSince: SINCE, subscriptionTtlSeconds: TTL }];
        }
        return configs;
      },
      $executeRaw: async (sql: TemplateStringsArray) => {
        statements.push(sql.join('?'));
        return 1;
      },
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
    const allocator = { rebalance: async () => ({}) };
    const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
    const service = new GroupDrainService(new ConfigActionsService(allocator as never), prisma as never, crossTenant as never);
    service.now = () => at(10);
    return { service, statements, retired, tx: tx as unknown as Prisma.TransactionClient };
  }

  it('retires the due configs, then removes the member only while it is still draining and bare', async () => {
    const { service, statements, retired } = build([drainConfig('c1'), drainConfig('c2')]);
    const result = await service.drainDue();

    expect(retired).toEqual(['c1', 'c2']);
    expect(result).toEqual({ scanned: 1, configsRetired: 2, grantsHeld: 0, membersRemoved: 1, failed: 0 });
    const remove = statements.find((s) => s.startsWith('DELETE'))!;
    expect(remove).toContain(`"role" = 'drain'`);
    expect(remove).toContain(`c."status" <> 'retired'`);
  });

  it('keeps the member when a Grant is held or a retire failed', async () => {
    const held = build([drainConfig('c1', { replacementSince: null }), drainConfig('c2')]);
    expect(await held.service.drainDue()).toEqual({ scanned: 1, configsRetired: 1, grantsHeld: 1, membersRemoved: 0, failed: 0 });
    expect(held.statements.some((s) => s.startsWith('DELETE'))).toBe(false);

    const failing = build([drainConfig('c1'), drainConfig('c2')], { failRetire: 'c1' });
    expect(await failing.service.drainDue()).toEqual({ scanned: 1, configsRetired: 1, grantsHeld: 0, membersRemoved: 0, failed: 1 });
    expect(failing.statements.some((s) => s.startsWith('DELETE'))).toBe(false);
  });
});
