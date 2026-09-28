/**
 * Every admin action on a Grant or config writes a row, and the Grant answers
 * them as its history (F-311-r, audit invariant #12).
 *
 * The way this breaks is a write added to `ResellerUserGrantsService` later
 * that forgets the row, so the invariant is asserted over **every write method
 * from one list** (`EVERY_WRITE`), as `settlement.service.spec.ts` does for
 * invariant #9: a new write is one line here, and a missing one is red.
 *
 * Each case asserts write order in one transaction — `['act', 'audit']` — so a
 * row written outside the act's transaction, or before it, is not checkable
 * as green. The acts themselves are mocked: their own specs pin what they do.
 */
import { AdminAction } from '@prisma/client';
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';

import { EntitlementRefused } from '../entitlement/grant';
import { ResellerUserGrantsService } from '../payment/gift/reseller-user-grants.service';
import { UserConfigsService } from '../traffic/user-configs';

vi.mock('../entitlement/freeze', () => ({
  freezeGrant: vi.fn(async () => (log.push('act'), { frozenUntil: null, configsDisabled: 2 })),
  unfreezeGrant: vi.fn(async () => (log.push('act'), { endsAt: new Date('2026-10-30T00:00:00Z'), configsRestored: 2 })),
}));
vi.mock('../entitlement/duration', () => ({
  changeGrantDuration: vi.fn(async () => (log.push('act'), { changeId: 'c1', endsAtBefore: new Date('2026-10-01T00:00:00Z'), endsAtAfter: new Date('2026-10-08T00:00:00Z'), revived: false })),
}));
vi.mock('../entitlement/traffic', () => ({
  adjustGrantTraffic: vi.fn(async () => (log.push('act'), { adjustmentId: 'a1', purchasedBytesBefore: BigInt(10), purchasedBytesAfter: BigInt(20), usedBytes: BigInt(5), spent: false, revived: false })),
  resetGrantTraffic: vi.fn(async () => (log.push('act'), { adjustmentId: 'a2', purchasedBytesBefore: BigInt(10), purchasedBytesAfter: BigInt(15), usedBytes: BigInt(5), resetBytes: BigInt(5), spent: false, revived: false })),
}));
vi.mock('../traffic/gift-bytes', () => ({
  giftGrantBytes: vi.fn(async () => (log.push('act'), { adjustmentId: 'a3', purchasedBytesBefore: BigInt(10), purchasedBytesAfter: BigInt(30), usedBytes: BigInt(5), spent: false, revived: false })),
}));
vi.mock('../traffic/grant-speed', () => ({
  SpeedCapRefused: class extends Error {},
  setGrantSpeed: vi.fn(async () => (log.push('act'), { grantId: GRANT, rateMbpsBefore: null, rateMbpsAfter: 20 })),
}));
vi.mock('../entitlement/devices', () => ({
  setGrantDeviceLimit: vi.fn(async () => (log.push('act'), { grantId: GRANT, adjustmentId: 'a4', limitBefore: null, limitAfter: 2, panelsNotEnforcing: [] })),
}));
vi.mock('../entitlement/delete', () => ({
  deleteGrant: vi.fn(async () => (log.push('act'), { deletionId: 'd1', statusBefore: 'active', configsReleased: 2, refund: false, refundedAmount: null, walletTransactionId: null, refundSkipped: null })),
}));
vi.mock('../entitlement/admin-issue', () => ({
  issueGrantByAdmin: vi.fn(async () => (log.push('act'), { grantId: NEW_GRANT, variantId: 'v1', status: 'active', startsAt: new Date(), endsAt: null, issued: repeat ? false : true })),
}));
vi.mock('../entitlement/admin-renewal', () => ({
  renewGrantByAdmin: vi.fn(async () => (log.push('act'), { renewalId: 'r1', grantId: GRANT, plan: true, bytes: BigInt(0), days: 30, forgivenBytes: BigInt(0), purchasedBytesBefore: BigInt(0), purchasedBytesAfter: BigInt(0), endsAtBefore: null, endsAtAfter: null, revived: false, renewed: !repeat })),
}));

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '66666666-6666-4666-8666-666666666666';
const GRANT = '99999999-9999-4999-8999-999999999999';
const NEW_GRANT = '12121212-1212-4212-8212-121212121212';
const CFG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CFG_OLD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IP = '203.0.113.7';

const admin = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[], ip: IP };

let log: string[] = [];
let repeat = false;

type Row = Record<string, unknown>;

function build() {
  log = [];
  const rows: Row[] = [];
  const scope = () => TenantContext.currentOrNull()?.id;
  const tenants: Record<string, unknown> = {
    [PLATFORM]: { id: PLATFORM, slug: 'platform', tenantType: 'platform_owner', ownerUserId: null, status: 'active', graceEndsAt: null, deletedAt: null },
    [RESELLER]: { id: RESELLER, slug: 'acme', tenantType: 'reseller', ownerUserId: OWNER_USER, status: 'active', graceEndsAt: null, deletedAt: null },
  };
  const access = new ResellerAccess({
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
      findFirst: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
    },
    tenantStaffMember: { findFirst: async () => null },
  } as never);

  const grantState = () => ({ status: log.includes('act') ? 'suspended' : 'active', statusReason: null, endsAt: null, purchasedBytes: BigInt(10), quotas: {}, tokenRotatedAt: new Date('2026-09-01T00:00:00Z') });
  const tx = {
    $executeRaw: async () => 1,
    user: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === CUSTOMER && scope() === RESELLER ? { id: CUSTOMER } : null) },
    grant: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) => (where.id === GRANT && where.userId === CUSTOMER ? { id: GRANT } : null),
      findUnique: async () => grantState(),
    },
    config: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) => (where.id === CFG_A && where.userId === CUSTOMER ? { id: CFG_A } : null),
      findUnique: async () => ({ grantId: GRANT, panelId: 'p', status: log.includes('act') ? 'disabled' : 'active', disabledReason: null, desiredEnabled: !log.includes('act'), desiredRemote: 'present' }),
      findMany: async () => [{ id: CFG_A }, { id: CFG_OLD }],
    },
    adminAuditLog: {
      create: async ({ data }: { data: Row }) => (log.push('audit'), rows.push({ ...data, scope: scope() }), data),
      findMany: async (args: Row) => ((history.findMany = args), []),
      count: async () => 0,
    },
  };
  const history: Row = {};
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };

  const configActions = { regenerate: async () => void log.push('act'), disable: async () => void log.push('act'), enable: async () => void log.push('act'), retire: async () => void log.push('act'), move: async () => (log.push('act'), { configId: 'moved-cfg' }) };
  const configs = new UserConfigsService(prisma as never, configActions as never);
  const links = { reset: async (_g: string, _u: string, around: (t: unknown, run: () => Promise<string>) => Promise<string>) => prisma.$transaction((t) => around(t, async () => (log.push('act'), 'https://sub.acme.test/sub/SECRET'))) };
  const remainders = { settle: async () => null };
  const service = new ResellerUserGrantsService(prisma as never, access, {} as never, configs, {} as never, links as never, remainders as never);
  return { service, rows, history };
}

type Case = { method: string; action: AdminAction; reason: string | null; call: (s: ResellerUserGrantsService) => Promise<unknown>; target?: string };

/** Every write `ResellerUserGrantsService` offers. A new write method is one line here. */
const EVERY_WRITE: Case[] = [
  { method: 'freeze', action: 'grant_freeze', reason: 'chargeback', call: (s) => s.freeze(admin, RESELLER, CUSTOMER, GRANT, null, 'chargeback') },
  { method: 'unfreeze', action: 'grant_unfreeze', reason: null, call: (s) => s.unfreeze(admin, RESELLER, CUSTOMER, GRANT, null) },
  { method: 'changeDuration', action: 'grant_duration_change', reason: 'outage', call: (s) => s.changeDuration(admin, RESELLER, CUSTOMER, GRANT, { days: 7 }, 'outage') },
  { method: 'changeTraffic', action: 'grant_traffic_change', reason: 'goodwill', call: (s) => s.changeTraffic(admin, RESELLER, CUSTOMER, GRANT, BigInt(10), 'goodwill') },
  { method: 'resetTraffic', action: 'grant_traffic_reset', reason: 'new month', call: (s) => s.resetTraffic(admin, RESELLER, CUSTOMER, GRANT, 'new month') },
  { method: 'giftTraffic', action: 'grant_traffic_gift', reason: 'gift', call: (s) => s.giftTraffic(admin, RESELLER, CUSTOMER, GRANT, BigInt(20), 'gift') },
  { method: 'setSpeed', action: 'grant_speed_set', reason: 'abuse', call: (s) => s.setSpeed(admin, RESELLER, CUSTOMER, GRANT, 20, 'abuse') },
  { method: 'setDevices', action: 'grant_devices_set', reason: 'sharing', call: (s) => s.setDevices(admin, RESELLER, CUSTOMER, GRANT, 2, 'sharing') },
  { method: 'deleteGrant', action: 'grant_delete', reason: 'asked', call: (s) => s.deleteGrant(admin, RESELLER, CUSTOMER, GRANT, false, 'asked') },
  { method: 'issue', action: 'grant_issue', reason: 'trial', target: NEW_GRANT, call: (s) => s.issue(admin, RESELLER, CUSTOMER, 'v1', 'req-1', 'trial') },
  { method: 'renew', action: 'grant_renew', reason: 'paid cash', call: (s) => s.renew(admin, RESELLER, CUSTOMER, GRANT, { requestId: 'req-2', reason: 'paid cash' }) },
  { method: 'rotateLink', action: 'grant_link_rotate', reason: 'leaked', call: (s) => s.rotateLink(admin, RESELLER, CUSTOMER, GRANT, 'leaked') },
  { method: 'act', action: 'config_disable', reason: 'abuse', target: CFG_A, call: (s) => s.act(admin, RESELLER, CUSTOMER, { action: 'disable', configIds: [CFG_A], reason: 'abuse' }) },
];

describe('an admin action on a Grant or config writes a row (F-311-r)', () => {
  beforeEach(() => {
    repeat = false;
  });

  it('covers every write method of ResellerUserGrantsService', () => {
    const writes = Object.getOwnPropertyNames(ResellerUserGrantsService.prototype).filter(
      (m) => !['constructor', 'grants', 'configs', 'usage', 'subscriptionLink', 'history', 'run', 'onGrant', 'audited'].includes(m),
    );
    expect(writes.sort()).toEqual(EVERY_WRITE.map((c) => c.method).sort());
  });

  it.each(EVERY_WRITE)('$method writes one $action row after the act, in its transaction, with actor, ip, reason and the reseller', async (c) => {
    const { service, rows } = build();

    await c.call(service);

    expect(log).toEqual(['act', 'audit']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: c.action,
      targetEntityType: c.action.startsWith('config_') ? 'config' : 'grant',
      targetEntityId: c.target ?? GRANT,
      adminId: OWNER_USER,
      adminIpAddress: IP,
      reason: c.reason,
      tenantId: RESELLER,
      scope: RESELLER,
    });
  });

  it('writes the state on either side of the act, bytes as text', async () => {
    const { service, rows } = build();
    await service.freeze(admin, RESELLER, CUSTOMER, GRANT, null, 'chargeback');
    expect(rows[0].oldValue).toMatchObject({ status: 'active', purchasedBytes: '10' });
    expect(rows[0].newValue).toMatchObject({ status: 'suspended', purchasedBytes: '10', outcome: { configsDisabled: 2 } });
  });

  it('never writes the new link into the row', async () => {
    const { service, rows } = build();
    const url = await service.rotateLink(admin, RESELLER, CUSTOMER, GRANT, null);
    expect(url).toContain('SECRET');
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  it('writes nothing for a refused act or a repeat', async () => {
    const { freezeGrant } = await import('../entitlement/freeze');
    vi.mocked(freezeGrant).mockRejectedValueOnce(new EntitlementRefused('grant_not_active'));
    const { service, rows } = build();

    await expect(service.freeze(admin, RESELLER, CUSTOMER, GRANT, null, 'x')).rejects.toThrow(EntitlementRefused);
    repeat = true;
    await service.renew(admin, RESELLER, CUSTOMER, GRANT, { requestId: 'req-2', reason: null });
    await service.issue(admin, RESELLER, CUSTOMER, 'v1', 'req-1', null);

    expect(rows).toEqual([]);
  });

  it("answers the Grant's history over it and every config it held, newest first", async () => {
    const { service, history } = build();
    await service.history(admin, RESELLER, CUSTOMER, GRANT, { page: 1, pageSize: 20 });
    expect(history.findMany).toMatchObject({
      where: { OR: [{ targetEntityType: 'grant', targetEntityId: GRANT }, { targetEntityType: 'config', targetEntityId: { in: [CFG_A, CFG_OLD] } }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });
});
