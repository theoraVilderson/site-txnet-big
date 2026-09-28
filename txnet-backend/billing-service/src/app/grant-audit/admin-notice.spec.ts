/**
 * An admin's act on a user's service is told to that user (F-311-s): every
 * act on a Grant or one of its configs writes one retention outbox row, in the
 * act's transaction and after its audit row, whose id is the notice's period —
 * so the ledger tells each act once (notification `contract.retention.md`).
 * The admin's reason is staff's and never reaches the user; neither does a
 * rotated link. An act that also brings a stopped service back says so in the
 * same message (`reactivated`), never in a second "active again".
 */
import { OutboxEventType } from '@txnet-backend/shared-core';

import { auditedConfigAct, auditedGrantAct, type ConfigAuditAction, type GrantAuditAction } from './grant-audit';

const TENANT = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999999';
const OWNER = '66666666-6666-4666-8666-666666666666';
const AUDIT_ID = '31313131-3131-4131-8131-313131313131';
const CONFIG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actor = { userId: '44444444-4444-4444-8444-444444444444', ip: '203.0.113.7' };

const GIB = BigInt(1024 ** 3);
const HOUR = 3_600_000;
const T0 = new Date('2026-10-01T00:00:00Z');
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);
const traffic = (before: bigint, after: bigint, reactivated = false) => ({ adjustmentId: 'a1', purchasedBytesBefore: before, purchasedBytesAfter: after, usedBytes: BigInt(0), spent: false, revived: reactivated, reactivated });
const renewal = (reactivated: boolean) => ({ renewalId: 'r1', grantId: GRANT, plan: true, bytes: BigInt(0), days: 30, revived: reactivated, reactivated, renewed: true });

type Row = Record<string, unknown>;

async function act(action: GrantAuditAction, result: unknown, opts: { changed?: boolean } = {}) {
  const log: string[] = [];
  const outbox: Row[] = [];
  const tx = fakeTx(log, outbox);
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

function fakeTx(log: string[], outbox: Row[]) {
  return {
    grant: {
      findUnique: async ({ select }: { select: Row }) => (select.userId ? { userId: OWNER } : { status: 'active', endsAt: null, purchasedBytes: BigInt(0) }),
    },
    config: { findUnique: async () => ({ grantId: GRANT, panelId: 'p', status: 'active', disabledReason: null, desiredEnabled: true, desiredRemote: 'present' }) },
    tenantDomain: { findMany: async () => [{ domainValue: 'panel.acme.test', domainType: 'custom_domain' }] },
    tenant: { findUnique: async () => ({ tenantType: 'reseller' }) },
    adminAuditLog: { create: async () => (log.push('audit'), { id: AUDIT_ID }) },
    outboxEvent: { create: async ({ data }: { data: Row }) => (log.push('notice'), outbox.push(data), { id: 'o1' }) },
  };
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
    result: { deletionId: 'd1', statusBefore: 'active', configsReleased: 2, refund: false, refundedAmount: null, currencyCode: null, walletTransactionId: null, refundSkipped: null },
    type: OutboxEventType.GRANT_ADMIN_DELETED,
    params: {},
  },
  { name: 'a rotated link', action: 'grant_link_rotate', result: 'https://sub.acme.test/sub/SECRET', type: OutboxEventType.GRANT_ADMIN_LINK_ROTATED, params: {} },
  { name: 'a speed cap', action: 'grant_speed_set', result: { grantId: GRANT, rateMbpsBefore: null, rateMbpsAfter: 20 }, type: OutboxEventType.GRANT_ADMIN_SPEED_CAPPED, params: { mbps: '20' } },
  { name: 'a speed cap lifted', action: 'grant_speed_set', result: { grantId: GRANT, rateMbpsBefore: 20, rateMbpsAfter: null }, type: OutboxEventType.GRANT_ADMIN_SPEED_UNCAPPED, params: {} },
  {
    name: 'a device limit',
    action: 'grant_devices_set',
    result: { grantId: GRANT, adjustmentId: 'a4', limitBefore: null, limitAfter: 2, panelsNotEnforcing: [] },
    type: OutboxEventType.GRANT_ADMIN_DEVICES_LIMITED,
    params: { limit: '2' },
  },
  {
    name: 'a device limit lifted',
    action: 'grant_devices_set',
    result: { grantId: GRANT, adjustmentId: 'a4', limitBefore: 2, limitAfter: null, panelsNotEnforcing: [] },
    type: OutboxEventType.GRANT_ADMIN_DEVICES_UNLIMITED,
    params: {},
  },
  { name: 'a renewal', action: 'grant_renew', result: renewal(false), type: OutboxEventType.GRANT_ADMIN_RENEWED, params: {} },
  {
    name: 'days that bring a lapsed service back, in one message',
    action: 'grant_duration_change',
    result: { changeId: 'c1', endsAtBefore: T0, endsAtAfter: at(24 * 30), revived: true, reactivated: true },
    type: OutboxEventType.GRANT_ADMIN_DAYS_ADDED,
    params: { days: '30', reactivated: 'yes' },
  },
  { name: 'traffic that brings a spent service back', action: 'grant_traffic_change', result: traffic(GIB, GIB * BigInt(6), true), type: OutboxEventType.GRANT_ADMIN_TRAFFIC_ADDED, params: { amount: '5.0 GB', reactivated: 'yes' } },
  { name: 'a gift that brings it back', action: 'grant_traffic_gift', result: traffic(GIB, GIB * BigInt(2), true), type: OutboxEventType.GRANT_ADMIN_TRAFFIC_ADDED, params: { amount: '1.0 GB', reactivated: 'yes' } },
  { name: 'a reset that brings it back', action: 'grant_traffic_reset', result: { ...traffic(GIB, GIB * BigInt(2), true), resetBytes: GIB }, type: OutboxEventType.GRANT_ADMIN_TRAFFIC_RESET, params: { reactivated: 'yes' } },
  { name: 'a renewal that brings it back', action: 'grant_renew', result: renewal(true), type: OutboxEventType.GRANT_ADMIN_RENEWED, params: { reactivated: 'yes' } },
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

  it("an issued service is told on the Grant it created, with the tenant's My services page", async () => {
    const NEW = '12121212-1212-4212-8212-121212121212';
    const log: string[] = [];
    const outbox: Row[] = [];
    await auditedGrantAct(
      fakeTx(log, outbox) as never,
      actor,
      TENANT,
      null,
      { action: 'grant_issue', reason: 'trial', targetOf: (r: { grantId: string }) => r.grantId },
      async () => (log.push('act'), { grantId: NEW, issued: true }),
    );
    expect(log).toEqual(['act', 'audit', 'notice']);
    expect(outbox).toEqual([
      expect.objectContaining({
        aggregateId: NEW,
        type: OutboxEventType.GRANT_ADMIN_ISSUED,
        payload: { tenantId: TENANT, userId: OWNER, grantId: NEW, period: AUDIT_ID, servicesUrl: 'https://panel.acme.test/services' },
      }),
    ]);
  });

  it.each<[ConfigAuditAction, string]>([
    ['config_regenerate', OutboxEventType.GRANT_ADMIN_CONFIG_REGENERATED],
    ['config_disable', OutboxEventType.GRANT_ADMIN_CONFIG_DISABLED],
    ['config_enable', OutboxEventType.GRANT_ADMIN_CONFIG_ENABLED],
    ['config_retire', OutboxEventType.GRANT_ADMIN_CONFIG_RETIRED],
    ['config_move', OutboxEventType.GRANT_ADMIN_CONFIG_MOVED],
  ])("%s is told on the config's Grant, after its audit row", async (action, type) => {
    const log: string[] = [];
    const outbox: Row[] = [];
    await auditedConfigAct(fakeTx(log, outbox) as never, actor, TENANT, CONFIG, action, 'abuse', async () => void log.push('act'));
    expect(log).toEqual(['act', 'audit', 'notice']);
    expect(outbox).toEqual([{ aggregate: 'entitlement.grant', aggregateId: GRANT, type, payload: { tenantId: TENANT, userId: OWNER, grantId: GRANT, period: AUDIT_ID } }]);
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
