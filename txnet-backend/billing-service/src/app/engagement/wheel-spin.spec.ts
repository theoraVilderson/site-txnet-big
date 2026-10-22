/**
 * The spin (F-707-d, ADR-0111 points 3, 4).
 *
 * What would break silently here, and nowhere else:
 *  - a refused spin that leaves no record (invariant 2), or a record without
 *    the checks that refused it (invariant 3);
 *  - a pick that is not the version's weights, or that the client chose;
 *  - a prize over the day's cap or past its stock: it becomes `empty`, the
 *    counters untouched — the database would refuse it, as a 500;
 *  - a prize the issuer cannot give (no active service) charged to the cap;
 *  - a retried request that spins twice;
 *  - a second spin past `maxSpinsPerAccountPerDay`, or inside the cooldown.
 */
import { Prisma, SpinAttemptStatus, SpinPrizeType } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { issueReward, RewardRefused } from './reward-issuer';
import { checkEligibility, EligibilityFacts, pickSlot, WheelSpinRefused, WheelSpinService } from './wheel-spin.service';

vi.mock('./reward-issuer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reward-issuer')>()),
  issueReward: vi.fn(async () => ({ rewardId: 'rw-1', prizeType: 'bonus_traffic_gb', replay: false, grantId: 'g-1', coupon: null })),
}));
vi.mock('../fraud/device-fingerprint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fraud/device-fingerprint')>()),
  recordFingerprint: vi.fn(async () => ({ id: 'fp-1', fingerprintHash: 'h' })),
  accountsOnFingerprint: vi.fn(async () => 1),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '99999999-9999-4999-8999-999999999999';
const AT = new Date('2026-10-03T12:00:00Z');
const HOUR = 3_600_000;
const D = (v: number | string) => new Prisma.Decimal(v);

const GB = { id: 'p1', position: 1, label: '1 GB', prizeType: SpinPrizeType.bonus_traffic_gb, prizeValue: D(1), couponTemplateId: null, couponValidDays: null, variantId: null, probabilityWeight: 30, costAmount: D(4), dailyStockLimit: 2 };
const NOTHING = { id: 'p2', position: 2, label: 'Nothing', prizeType: SpinPrizeType.empty, prizeValue: D(0), couponTemplateId: null, couponValidDays: null, variantId: null, probabilityWeight: 70, costAmount: D(0), dailyStockLimit: null };

const config = (over = {}) => ({
  id: 'cfg-1', version: 2, isActive: true, dailyBudgetCapAmount: D(10), currencyCode: 'USD', perUserCooldownHours: 0, maxSpinsPerAccountPerDay: 1,
  requiresMinAccountAgeHours: 24, requiresMinTotalPurchaseAmount: null, requiresMinCompletedOrdersCount: null,
  requiresActiveServiceAtSpinTime: true, requiresPhoneVerified: true, userGroupId: null, createdByAdminId: ADMIN, prizes: [GB, NOTHING], ...over,
});

const facts = (over: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  userActive: true, accountCreatedAt: new Date(AT.getTime() - 48 * HOUR), phoneVerified: true, activeGrants: 1, totalPaid: D(0), paidOrders: 0,
  openFraudFlags: 0, accountsOnFingerprint: 1, inGroup: null, awardedToday: 0, lastAwardedAt: null, ...over,
});

function build(o: { cfg?: ReturnType<typeof config> | null; day?: { costSpent: number; spins: number }; prizeDay?: number; roll?: number; attempts?: Record<string, unknown>[]; user?: Record<string, unknown> } = {}) {
  const attempts: Record<string, unknown>[] = [...(o.attempts ?? [])];
  const raw: string[] = [];
  const dayUpdates: Record<string, unknown>[] = [];
  const prizeDayUpdates: Record<string, unknown>[] = [];
  const tx = {
    $executeRaw: async (s: TemplateStringsArray) => raw.push(s.join('?')),
    $queryRaw: async (s: TemplateStringsArray) =>
      s.join('?').includes('spin_wheel_prize_day') ? [{ awardedCount: o.prizeDay ?? 0 }] : [{ costSpent: D(o.day?.costSpent ?? 0), spins: o.day?.spins ?? 0 }],
    tenant: { findUnique: async () => ({ timezone: 'UTC', operatingCurrencyCode: 'USD' }) },
    spinWheelConfig: { findFirst: async () => (o.cfg === undefined ? config() : o.cfg) },
    spinWheelAttempt: {
      findUnique: async ({ where }: { where: { tenantId_userId_idempotencyKey: { idempotencyKey: string } } }) =>
        attempts.find((a) => a.idempotencyKey === where.tenantId_userId_idempotencyKey.idempotencyKey) ?? null,
      findMany: async () => attempts.filter((a) => a.status === SpinAttemptStatus.awarded),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        attempts.push(data);
        return data;
      },
    },
    spinWheelDay: { update: async (a: Record<string, unknown>) => dayUpdates.push(a) },
    spinWheelPrizeDay: { update: async (a: Record<string, unknown>) => prizeDayUpdates.push(a) },
    user: { findUnique: async () => ({ status: 'active', deletedAt: null, createdAt: new Date(AT.getTime() - 48 * HOUR), phoneVerifiedAt: AT, ...o.user }) },
    grant: { count: async () => 1, findMany: async () => [{ trafficUnlimited: false, endsAt: new Date('2099-01-01T00:00:00Z') }] },
    invoice: { aggregate: async () => ({ _sum: { total: D(0) }, _count: { _all: 0 } }) },
    fraudFlag: { count: async () => 0 },
    userGroupMember: { findFirst: async () => null },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const service = new WheelSpinService(prisma as never, {} as never, () => AT, () => o.roll ?? 0);
  return { service, attempts, raw, dayUpdates, prizeDayUpdates };
}

const asTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);
const web = { channel: 'web' as const, ip: '203.0.113.9', userAgent: 'ua', deviceId: 'dev' };
const spin = (s: WheelSpinService, key = 'k-1') => asTenant(() => s.spin({ userId: USER, tenantId: TENANT }, { requestId: key, source: web }));

beforeEach(() => vi.mocked(issueReward).mockClear());

describe('pickSlot', () => {
  it('walks the weights: a roll below the first weight is the first slot, the rest the next', () => {
    expect(pickSlot([GB, NOTHING], () => 0).id).toBe('p1');
    expect(pickSlot([GB, NOTHING], () => 29).id).toBe('p1');
    expect(pickSlot([GB, NOTHING], () => 30).id).toBe('p2');
    expect(pickSlot([GB, NOTHING], () => 99).id).toBe('p2');
  });
  it('asks the random source for a number below the total weight', () => {
    const rand = vi.fn(() => 0);
    pickSlot([GB, NOTHING], rand);
    expect(rand).toHaveBeenCalledWith(100);
  });
});

describe('checkEligibility', () => {
  it('passes a user who meets every rule, and names each check in the snapshot', () => {
    const r = checkEligibility(config(), facts(), AT);
    expect(r.refusal).toBeNull();
    expect(Object.keys(r.checks)).toEqual(expect.arrayContaining(['accountAge', 'phoneVerified', 'activeService', 'notFlagged', 'device', 'dailyLimit', 'cooldown']));
  });
  it.each([
    ['an account younger than the rule', { accountCreatedAt: new Date(AT.getTime() - 2 * HOUR) }, 'account_too_new', SpinAttemptStatus.rejected_ineligible],
    ['no verified phone', { phoneVerified: false }, 'phone_not_verified', SpinAttemptStatus.rejected_ineligible],
    ['no active service', { activeGrants: 0 }, 'no_active_service', SpinAttemptStatus.rejected_ineligible],
    ['an open fraud flag', { openFraudFlags: 1 }, 'flagged', SpinAttemptStatus.voided_fraud],
    ['a device behind 5 accounts', { accountsOnFingerprint: 5 }, 'shared_device', SpinAttemptStatus.voided_fraud],
    ['the day’s spins used', { awardedToday: 1 }, 'daily_limit', SpinAttemptStatus.rejected_ineligible],
  ])('refuses %s', (_why, over, reason, status) => {
    const r = checkEligibility(config(), facts(over), AT);
    expect(r.refusal).toEqual({ reason, status });
  });
  it('holds the cooldown between two awarded spins, the minimum total paid and the group', () => {
    const cfg = config({ maxSpinsPerAccountPerDay: 3, perUserCooldownHours: 4, requiresMinTotalPurchaseAmount: D(20), userGroupId: 'grp' });
    expect(checkEligibility(cfg, facts({ awardedToday: 1, lastAwardedAt: new Date(AT.getTime() - HOUR), totalPaid: D(50), inGroup: true }), AT).refusal?.reason).toBe('cooldown');
    expect(checkEligibility(cfg, facts({ totalPaid: D(19.99), inGroup: true }), AT).refusal?.reason).toBe('paid_too_little');
    expect(checkEligibility(cfg, facts({ totalPaid: D(20), inGroup: false }), AT).refusal?.reason).toBe('not_in_group');
  });
});

describe('WheelSpinService.spin', () => {
  it('awards the picked slot: counters charged, prize issued in the same transaction, attempt seq 1', async () => {
    const { service, attempts, dayUpdates, prizeDayUpdates } = build({ roll: 0 });
    const r = await spin(service);
    expect(r).toMatchObject({ status: SpinAttemptStatus.awarded, position: 1, seq: 1, prize: { prizeType: SpinPrizeType.bonus_traffic_gb } });
    expect(attempts[0]).toMatchObject({ status: SpinAttemptStatus.awarded, seq: 1, pickedPrizeId: 'p1', prizeAwardedId: 'p1', costAmount: '4.00', deviceFingerprintId: 'fp-1' });
    expect(vi.mocked(issueReward).mock.calls[0][2]).toMatchObject({ source: 'spin', referenceId: attempts[0].id, actorUserId: ADMIN });
    expect(dayUpdates).toHaveLength(1);
    expect(prizeDayUpdates).toHaveLength(1);
  });

  it('turns a pick over the day’s cap into nothing, landing on an empty slot, the cap untouched', async () => {
    const { service, attempts } = build({ roll: 0, day: { costSpent: 8, spins: 5 } });
    const r = await spin(service);
    expect(r).toMatchObject({ status: SpinAttemptStatus.awarded, position: 2, prize: null });
    expect(attempts[0]).toMatchObject({ pickedPrizeId: 'p1', prizeAwardedId: null, costAmount: '0.00' });
    expect(issueReward).not.toHaveBeenCalled();
  });

  it('turns a pick past its daily stock into nothing', async () => {
    const { service, attempts } = build({ roll: 0, prizeDay: 2 });
    await spin(service);
    expect(attempts[0]).toMatchObject({ pickedPrizeId: 'p1', prizeAwardedId: null });
  });

  it('a prize the issuer refuses is rolled back to its savepoint and given as nothing', async () => {
    vi.mocked(issueReward).mockRejectedValueOnce(new RewardRefused('no_active_grant'));
    const { service, attempts, raw, dayUpdates } = build({ roll: 0, cfg: config({ requiresActiveServiceAtSpinTime: false }) });
    const r = await spin(service);
    expect(r.prize).toBeNull();
    expect(raw.some((s) => s.includes('ROLLBACK TO SAVEPOINT'))).toBe(true);
    expect(attempts[0]).toMatchObject({ prizeAwardedId: null, costAmount: '0.00' });
    expect(dayUpdates[0]).toMatchObject({ data: { costSpent: { increment: '0.00' } } });
  });

  it('records a refused spin, with its checks, and gives nothing', async () => {
    const { service, attempts } = build({ user: { phoneVerifiedAt: null } });
    const r = await spin(service);
    expect(r).toMatchObject({ status: SpinAttemptStatus.rejected_ineligible, refusalReason: 'phone_not_verified', prize: null, position: null });
    expect(attempts[0]).toMatchObject({ status: SpinAttemptStatus.rejected_ineligible, seq: null, refusalReason: 'phone_not_verified' });
    expect((attempts[0].eligibilityCheckSnapshotJson as { checks: Record<string, { ok: boolean }> }).checks.phoneVerified.ok).toBe(false);
    expect(issueReward).not.toHaveBeenCalled();
  });

  it('answers a retried request from its record, spinning nothing', async () => {
    const { service, attempts } = build({ roll: 0 });
    await spin(service, 'same');
    const again = await spin(service, 'same');
    expect(attempts).toHaveLength(1);
    expect(again).toMatchObject({ replay: true, attemptId: attempts[0].id });
  });

  it('refuses with no wheel in force, or no way to tell the device, and records nothing', async () => {
    await expect(spin(build({ cfg: null }).service)).rejects.toMatchObject({ reason: 'no_wheel' });
    await expect(spin(build({ cfg: config({ isActive: false }) }).service)).rejects.toMatchObject({ reason: 'no_wheel' });
    const { service, attempts } = build();
    await expect(asTenant(() => service.spin({ userId: USER, tenantId: TENANT }, { requestId: 'k', source: null }))).rejects.toBeInstanceOf(WheelSpinRefused);
    expect(attempts).toEqual([]);
  });
});

describe('WheelSpinService.inviteCheck (F-038-u)', () => {
  it('answers whether the user may spin now, read with no device — the spin checks the device itself', async () => {
    await expect(build().service.inviteCheck({ userId: USER, tenantId: TENANT })).resolves.toEqual({ wheel: true, eligible: true, refusalReason: null, spinsLeftToday: 1 });
    const spun = build({ attempts: [{ status: SpinAttemptStatus.awarded, attemptedAt: AT }] });
    await expect(spun.service.inviteCheck({ userId: USER, tenantId: TENANT })).resolves.toMatchObject({ wheel: true, eligible: false, refusalReason: 'daily_limit' });
  });

  it('answers wheel: false where none is in force, in the tenant it names', async () => {
    await expect(build({ cfg: null }).service.inviteCheck({ userId: USER, tenantId: TENANT })).resolves.toEqual({ wheel: false });
  });
});

describe('WheelSpinService.history', () => {
  const COUPON_PRIZE = { label: '20% off', prizeType: SpinPrizeType.discount_coupon, prizeValue: D(20) };
  function withHistory(rows: Record<string, unknown>[]) {
    const where: Record<string, unknown>[] = [];
    const { service } = build();
    const tx = {
      $executeRaw: async () => 0,
      spinWheelAttempt: {
        findMany: async (a: { where: Record<string, unknown> }) => {
          where.push(a.where);
          return rows;
        },
      },
      rewardIssue: { findMany: async () => [{ referenceId: 'a-1', couponId: 'c-1' }] },
      coupon: { findMany: async () => [{ id: 'c-1', code: 'WHEEL-7Q2', expiresAt: new Date('2026-10-10T00:00:00Z') }] },
    };
    (service as unknown as { prisma: unknown }).prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
    return { service, where };
  }

  it("is the caller's own attempts, newest first, a won coupon named by its code", async () => {
    const { service, where } = withHistory([
      { id: 'a-1', attemptedAt: AT, tenantDay: AT, status: SpinAttemptStatus.awarded, refusalReason: null, prizeAwarded: COUPON_PRIZE, eligibilityCheckSnapshotJson: { checks: {} } },
      { id: 'a-0', attemptedAt: new Date(AT.getTime() - HOUR), tenantDay: AT, status: SpinAttemptStatus.rejected_ineligible, refusalReason: 'cooldown', prizeAwarded: null, eligibilityCheckSnapshotJson: { checks: {} } },
    ]);
    const rows = await asTenant(() => service.history({ userId: USER, tenantId: TENANT }));
    expect(where[0]).toMatchObject({ tenantId: TENANT, userId: USER });
    expect(rows).toEqual([
      { attemptId: 'a-1', at: AT.toISOString(), tenantDay: '2026-10-03', status: 'awarded', refusalReason: null, prize: { label: '20% off', prizeType: 'discount_coupon', prizeValue: '20.00' }, coupon: { code: 'WHEEL-7Q2', expiresAt: '2026-10-10T00:00:00.000Z' } },
      { attemptId: 'a-0', at: new Date(AT.getTime() - HOUR).toISOString(), tenantDay: '2026-10-03', status: 'rejected_ineligible', refusalReason: 'cooldown', prize: null, coupon: null },
    ]);
  });
});
