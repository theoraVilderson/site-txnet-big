/**
 * An admin's act on a user's service is told to that user (F-311-s): freeze,
 * unfreeze, days, traffic (a gift included), reset, delete and a rotated link
 * each write one retention outbox row, in the act's transaction and after its
 * audit row, whose id is the notice's period — so the ledger tells each act
 * once (notification `contract.retention.md`). The admin's reason is staff's
 * and never reaches the user; neither does a rotated link.
 */
import { OutboxEventType } from '@txnet-backend/shared-core';

import { auditedGrantAct, type GrantAuditAction } from './grant-audit';

const TENANT = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999999';
const OWNER = '66666666-6666-4666-8666-666666666666';
const AUDIT_ID = '31313131-3131-4131-8131-313131313131';
const actor = { userId: '44444444-4444-4444-8444-444444444444', ip: '203.0.113.7' };

const GIB = BigInt(1024 ** 3);
const HOUR = 3_600_000;
const T0 = new Date('2026-10-01T00:00:00Z');
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);
const traffic = (before: bigint, after: bigint) => ({ adjustmentId: 'a1', purchasedBytesBefore: before, purchasedBytesAfter: after, usedBytes: BigInt(0), spent: false, revived: false });

type Row = Record<string, unknown>;

async function act(action: GrantAuditAction, result: unknown, opts: { changed?: boolean } = {}) {
  const log: string[] = [];
  const outbox: Row[] = [];
  const tx = {
    grant: {
      findUnique: async ({ select }: { select: Row }) => (select.userId ? { userId: OWNER } : { status: 'active', endsAt: null, purchasedBytes: BigInt(0) }),
    },
    adminAuditLog: { create: async () => (log.push('audit'), { id: AUDIT_ID }) },
    outboxEvent: { create: async ({ data }: { data: Row }) => (log.push('notice'), outbox.push(data), { id: 'o1' }) },
  };
  await auditedGrantAct(
    tx as never,
    actor,
    TENANT,
    GRANT,
    { action, reason: 'chargeback from bank', changed: opts.changed === false ? () => false : undefined, outcome: (r) => r },
    async () => (log.push('act'), result),
  );
  return { log, outbox };
}

const TOLD: { name: string; action: GrantAuditAction; result: unknown; type: string; params: Row }[] = [
  { name: 'a freeze', action: 'grant_freeze', result: { frozenUntil: null, configsDisabled: 2 }, type: OutboxEventType.GRANT_ADMIN_FROZEN, params: {} },
  { name: 'an unfreeze', action: 'grant_unfreeze', result: { endsAt: at(24 * 30), configsRestored: 2 }, type: OutboxEventType.GRANT_ADMIN_UNFROZEN, params: {} },
  {
    name: 'days added',
    action: 'grant_duration_change',
    result: { changeId: 'c1', endsAtBefore: T0, endsAtAfter: at(24 * 7), revived: false },
    type: OutboxEventType.GRANT_ADMIN_DAYS_ADDED,
    params: { days: '7' },
  },
  {
    name: 'days removed',
    action: 'grant_duration_change',
    result: { changeId: 'c1', endsAtBefore: T0, endsAtAfter: at(-24 * 3), revived: false },
    type: OutboxEventType.GRANT_ADMIN_DAYS_REMOVED,
    params: { days: '3' },
  },
  {
    name: 'a move to a date, in whole days, never zero',
    action: 'grant_duration_change',
    result: { changeId: 'c1', endsAtBefore: T0, endsAtAfter: at(5), revived: false },
    type: OutboxEventType.GRANT_ADMIN_DAYS_ADDED,
    params: { days: '1' },
  },
  { name: 'traffic added', action: 'grant_traffic_change', result: traffic(GIB * BigInt(10), GIB * BigInt(15)), type: OutboxEventType.GRANT_ADMIN_TRAFFIC_ADDED, params: { amount: '5.0 GB' } },
  { name: 'traffic removed', action: 'grant_traffic_change', result: traffic(GIB * BigInt(50), GIB * BigInt(30)), type: OutboxEventType.GRANT_ADMIN_TRAFFIC_REMOVED, params: { amount: '20 GB' } },
  { name: 'a gift of bytes', action: 'grant_traffic_gift', result: traffic(GIB, GIB * BigInt(3)), type: OutboxEventType.GRANT_ADMIN_TRAFFIC_ADDED, params: { amount: '2.0 GB' } },
  { name: 'a reset', action: 'grant_traffic_reset', result: { ...traffic(GIB, GIB * BigInt(2)), resetBytes: GIB }, type: OutboxEventType.GRANT_ADMIN_TRAFFIC_RESET, params: {} },
  {
    name: 'a delete',
    action: 'grant_delete',
    result: { deletionId: 'd1', statusBefore: 'active', configsReleased: 2, refund: false, refundedAmount: null, walletTransactionId: null, refundSkipped: null },
    type: OutboxEventType.GRANT_ADMIN_DELETED,
    params: {},
  },
  { name: 'a rotated link', action: 'grant_link_rotate', result: 'https://sub.acme.test/sub/SECRET', type: OutboxEventType.GRANT_ADMIN_LINK_ROTATED, params: {} },
];

describe("an admin's act on a service is told to its owner (F-311-s)", () => {
  it.each(TOLD)('$name: one $type row after the audit row, the act its period', async (c) => {
    const { log, outbox } = await act(c.action, c.result);

    expect(log).toEqual(['act', 'audit', 'notice']);
    expect(outbox).toEqual([
      {
        aggregate: 'entitlement.grant',
        aggregateId: GRANT,
        type: c.type,
        payload: { tenantId: TENANT, userId: OWNER, grantId: GRANT, period: AUDIT_ID, ...c.params },
      },
    ]);
  });

  it("never tells the admin's reason, nor a rotated link", async () => {
    for (const c of TOLD) {
      const { outbox } = await act(c.action, c.result);
      expect(JSON.stringify(outbox)).not.toMatch(/chargeback|SECRET/);
    }
  });

  it.each<[GrantAuditAction, unknown]>([
    ['grant_speed_set', { grantId: GRANT, rateMbpsBefore: null, rateMbpsAfter: 20 }],
    ['grant_devices_set', { grantId: GRANT, adjustmentId: 'a4', limitBefore: null, limitAfter: 2, panelsNotEnforcing: [] }],
    ['grant_renew', { renewalId: 'r1', renewed: true }],
  ])('%s is audited and told nothing here', async (action, result) => {
    const { log, outbox } = await act(action, result);
    expect(log).toEqual(['act', 'audit']);
    expect(outbox).toEqual([]);
  });

  it('a repeat that changed nothing is neither audited nor told', async () => {
    const { log, outbox } = await act('grant_freeze', { frozenUntil: null, configsDisabled: 0 }, { changed: false });
    expect(log).toEqual(['act']);
    expect(outbox).toEqual([]);
  });

  it('a refused act tells nothing: the throw leaves before the audit row', async () => {
    const outbox: Row[] = [];
    const tx = { grant: { findUnique: async () => ({}) }, outboxEvent: { create: async ({ data }: { data: Row }) => outbox.push(data) } };
    await expect(
      auditedGrantAct(tx as never, actor, TENANT, GRANT, { action: 'grant_freeze', reason: null }, async () => {
        throw new Error('grant_not_active');
      }),
    ).rejects.toThrow('grant_not_active');
    expect(outbox).toEqual([]);
  });
});
