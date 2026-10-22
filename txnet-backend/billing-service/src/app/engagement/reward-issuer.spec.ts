/**
 * The reward issuer (F-707-b, ADR-0111 point 2), shared by the wheel and the
 * lottery.
 *
 * What breaks silently here: a retried spin that gives its prize twice; a
 * prize "queued" for a user with no service, so a later purchase quietly
 * collects it; GB landing on a Grant that is about to end when another runs
 * for months; a coupon worth more than the tenant's own template; cash.
 * The Grant-changing acts are mocked — their own specs pin what they do; this
 * one pins what the issuer decides: which act, on which Grant, how much, and
 * whether at all.
 */
import { CouponVisibility, DiscountType, GrantSource, GrantStatus, Prisma, RewardSource, SpinPrizeType, VariantBillingMode } from '@prisma/client';

import { issueGrantByAdmin } from '../entitlement/admin-issue';
import { changeGrantDuration } from '../entitlement/duration';
import { GrantService } from '../entitlement/grant';
import { adjustGrantTraffic } from '../entitlement/traffic';
import { giftGrantBytes } from '../traffic/gift-bytes';
import { issueReward, RewardPrize, RewardRefused } from './reward-issuer';

vi.mock('../entitlement/traffic', () => ({ adjustGrantTraffic: vi.fn(async () => ({ adjustmentId: 'adj-1' })) }));
vi.mock('../traffic/gift-bytes', () => ({ giftGrantBytes: vi.fn(async () => ({ adjustmentId: 'adj-2' })) }));
vi.mock('../entitlement/duration', () => ({ changeGrantDuration: vi.fn(async () => ({ changeId: 'dur-1' })) }));
vi.mock('../entitlement/admin-issue', () => ({ issueGrantByAdmin: vi.fn(async () => ({ grantId: 'g-free', issued: true })) }));

const TENANT = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000b1';
const ADMIN = '00000000-0000-4000-8000-0000000000c1';
const AT = new Date('2026-10-03T12:00:00Z');
const in_ = (days: number) => new Date(AT.getTime() + days * 86_400_000);
const GIB = BigInt(1024 * 1024 * 1024);

type GrantRow = { id: string; status: GrantStatus; billingMode: VariantBillingMode; trafficUnlimited: boolean; startsAt: Date; endsAt: Date | null };
const grant = (id: string, over: Partial<GrantRow> = {}): GrantRow => ({
  id, status: GrantStatus.active, billingMode: VariantBillingMode.prepaid, trafficUnlimited: false, startsAt: in_(-10), endsAt: in_(20), ...over,
});

type Template = { tenantId: string; deletedAt: Date | null; discountType: DiscountType; discountValue: Prisma.Decimal; maxDiscountCap: Prisma.Decimal | null; currencyCode: string };

function fakeTx(o: { grants?: GrantRow[]; template?: Template | null; tenantType?: string; chosen?: string } = {}) {
  const issues: Record<string, unknown>[] = [];
  const coupons: Record<string, unknown>[] = [];
  const tx = {
    grant: {
      findMany: vi.fn(async ({ where }) => (o.grants ?? []).filter((g) => g.status === where.status && (!where.id || g.id === where.id))),
      // The service a prize went to, as My services names it (F-707-y).
      findUnique: vi.fn(async ({ where }) => ({ userLabel: where.id === 'g-family' ? 'Family' : null, variant: { sku: `SKU-${where.id}`, nameKey: null, product: { nameKey: 'catalog.p.gold' } } })),
    },
    rewardTarget: { findUnique: vi.fn(async () => (o.chosen ? { grantId: o.chosen } : null)) },
    rewardIssue: {
      findUnique: vi.fn(async ({ where }) => issues.find((r) => r.source === where.source_referenceId.source && r.referenceId === where.source_referenceId.referenceId) ?? null),
      create: vi.fn(async ({ data }) => {
        const row = { id: `rw-${issues.length + 1}`, ...data };
        issues.push(row);
        return row;
      }),
    },
    coupon: {
      findFirst: vi.fn(async ({ where }) => {
        if (where.id && coupons.some((c) => c.id === where.id)) return coupons.find((c) => c.id === where.id);
        const t = o.template;
        return t && t.tenantId === where.tenantId && t.deletedAt === null ? { ...t, allowedChannels: [], gateways: [], serviceScopes: [{ productId: 'p1', variantId: null }] } : null;
      }),
      create: vi.fn(async ({ data }) => {
        const row = { id: `cp-${coupons.length + 1}`, ...data };
        coupons.push(row);
        return row;
      }),
    },
    tenant: { findUnique: vi.fn(async () => ({ tenantType: o.tenantType ?? 'reseller' })) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, issues, coupons };
}

const grants = {} as GrantService;
const prize = (prizeType: SpinPrizeType, value: number, over: Partial<RewardPrize> = {}): RewardPrize => ({
  prizeType, prizeValue: new Prisma.Decimal(value), couponTemplateId: null, couponValidDays: null, variantId: null, ...over,
});
const input = (p: RewardPrize, over = {}) => ({
  tenantId: TENANT, userId: USER, source: RewardSource.spin, referenceId: 'att-1', prize: p, actorUserId: ADMIN, at: AT, ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('bonus GB', () => {
  it('lands on the active Grant that runs longest, as an engagement reward', async () => {
    const { tx, issues } = fakeTx({
      grants: [
        grant('g-soon', { endsAt: in_(2) }),
        grant('g-long', { endsAt: in_(60) }),
        grant('g-unlimited', { trafficUnlimited: true, endsAt: in_(90) }),
        grant('g-suspended', { status: GrantStatus.suspended, endsAt: in_(99) }),
      ],
    });
    const issued = await issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 2)));
    expect(issued).toMatchObject({ grantId: 'g-long', replay: false });
    expect(vi.mocked(adjustGrantTraffic).mock.calls[0][1]).toBe('g-long');
    expect(vi.mocked(adjustGrantTraffic).mock.calls[0][2]).toMatchObject({ deltaBytes: BigInt(2) * GIB, source: GrantSource.engagement_reward, actorUserId: ADMIN });
    expect(issues).toEqual([expect.objectContaining({ grantId: 'g-long', quotaAdjustmentId: 'adj-1', source: RewardSource.spin, referenceId: 'att-1' })]);
  });

  it("goes into a metered Grant's bag as a gift the reseller bears", async () => {
    const { tx } = fakeTx({ grants: [grant('g-metered', { billingMode: VariantBillingMode.metered, endsAt: null })] });
    await issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 0.5)));
    expect(adjustGrantTraffic).not.toHaveBeenCalled();
    expect(vi.mocked(giftGrantBytes).mock.calls[0][2]).toMatchObject({ bytes: GIB / BigInt(2), giver: 'reseller', source: GrantSource.engagement_reward });
  });

  it('is refused, never queued, when no active Grant can take it', async () => {
    const { tx, issues } = fakeTx({ grants: [grant('g-unlimited', { trafficUnlimited: true }), grant('g-off', { status: GrantStatus.suspended })] });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 1)))).rejects.toMatchObject({ reason: 'no_active_grant' });
    expect(issues).toEqual([]);
    expect(adjustGrantTraffic).not.toHaveBeenCalled();
  });

  it("goes to the Grant the caller names only when it is the user's and can take it", async () => {
    const { tx } = fakeTx({ grants: [grant('g-a', { endsAt: in_(5) }), grant('g-unlimited', { trafficUnlimited: true })] });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 1), { grantId: 'g-unlimited' }))).rejects.toMatchObject({ reason: 'grant_not_eligible' });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 1), { grantId: 'g-a' }))).resolves.toMatchObject({ grantId: 'g-a' });
  });
});

describe("the user's prize service (F-707-r)", () => {
  const two = (over: Partial<GrantRow> = {}) => [grant('g-long', { endsAt: in_(60) }), grant('g-family', { endsAt: in_(10), ...over })];

  it('takes GB and days over the one that runs longest', async () => {
    const { tx } = fakeTx({ grants: two(), chosen: 'g-family' });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 5)))).resolves.toMatchObject({ grantId: 'g-family' });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.extra_days, 3), { referenceId: 'att-2' }))).resolves.toMatchObject({ grantId: 'g-family' });
  });

  it('falls back, never refuses, when the choice cannot take this prize', async () => {
    const { tx } = fakeTx({ grants: two({ trafficUnlimited: true }), chosen: 'g-family' });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 5)))).resolves.toMatchObject({ grantId: 'g-long' });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.extra_days, 3), { referenceId: 'att-2' }))).resolves.toMatchObject({ grantId: 'g-family' });
  });

  it('falls back when the choice is no longer active', async () => {
    const { tx } = fakeTx({ grants: two({ status: GrantStatus.expired }), chosen: 'g-family' });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 5)))).resolves.toMatchObject({ grantId: 'g-long' });
  });

  it('names the service the prize went to, the first time and on a retry (F-707-y)', async () => {
    const { tx } = fakeTx({ grants: two(), chosen: 'g-family' });
    const service = { label: 'Family', sku: 'SKU-g-family', nameKey: 'catalog.p.gold' };
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 5)))).resolves.toMatchObject({ service });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 5)))).resolves.toMatchObject({ replay: true, service });
  });

  it('gives way to a Grant the caller names', async () => {
    const { tx } = fakeTx({ grants: two(), chosen: 'g-family' });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 5), { grantId: 'g-long' }))).resolves.toMatchObject({ grantId: 'g-long' });
  });
});

describe('extra days', () => {
  it('move the end of a Grant that has one', async () => {
    const { tx, issues } = fakeTx({ grants: [grant('g-forever', { endsAt: null }), grant('g-ends', { endsAt: in_(3) })] });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.extra_days, 7)))).resolves.toMatchObject({ grantId: 'g-ends' });
    expect(vi.mocked(changeGrantDuration).mock.calls[0][2]).toMatchObject({ change: { days: 7 }, actorUserId: ADMIN });
    expect(issues[0]).toMatchObject({ durationChangeId: 'dur-1' });
  });
});

describe('a personal coupon (ADR-0110 clone)', () => {
  const coupon = (validDays = 7) => prize(SpinPrizeType.discount_coupon, 20, { couponTemplateId: 'tpl-1', couponValidDays: validDays });
  const template = (over: Partial<Template> = {}): Template => ({
    tenantId: TENANT, deletedAt: null, discountType: DiscountType.percentage, discountValue: new Prisma.Decimal(30), maxDiscountCap: null, currencyCode: 'IRT', ...over,
  });

  it('is single-use, for this user alone, at the lower percent, expiring with the prize', async () => {
    const { tx, coupons } = fakeTx({ template: template() });
    const issued = await issueReward(tx, grants, input(coupon()));
    expect(issued.coupon).toMatchObject({ percent: '20.00', expiresAt: in_(7) });
    expect(coupons[0]).toMatchObject({
      tenantId: TENANT, discountType: DiscountType.percentage, discountValue: '20.00', totalUsageLimit: 1, perUserUsageLimit: 1,
      visibility: CouponVisibility.targeted, currencyCode: 'IRT', expiresAt: in_(7), allowedUsers: { create: [{ userId: USER }] },
    });
  });

  it("never gives more than the template: a smaller percent, or a fixed amount as the cap", async () => {
    const low = fakeTx({ template: template({ discountValue: new Prisma.Decimal(10) }) });
    await expect(issueReward(low.tx, grants, input(coupon()))).resolves.toMatchObject({ coupon: { percent: '10.00' } });
    const fixed = fakeTx({ template: template({ discountType: DiscountType.fixed_amount, discountValue: new Prisma.Decimal(50000) }) });
    await issueReward(fixed.tx, grants, input(coupon()));
    expect(fixed.coupons[0]).toMatchObject({ discountValue: '20.00', maxDiscountCap: '50000.00' });
  });

  it("is refused for another tenant's or a deleted template", async () => {
    for (const t of [template({ tenantId: 'other' }), template({ deletedAt: AT })]) {
      const { tx } = fakeTx({ template: t });
      await expect(issueReward(tx, grants, input(coupon()))).rejects.toMatchObject({ reason: 'coupon_template_unavailable' });
    }
  });
});

describe('a free Grant', () => {
  it("is issued as the reward's, once per reference, inside the reseller's own limits", async () => {
    const { tx } = fakeTx({ tenantType: 'reseller' });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.free_grant, 0, { variantId: 'v-1' })))).resolves.toMatchObject({ grantId: 'g-free' });
    expect(vi.mocked(issueGrantByAdmin).mock.calls[0][2]).toMatchObject({
      userId: USER, variantId: 'v-1', requestId: 'att-1', source: GrantSource.engagement_reward, bounded: true,
    });
  });
});

describe('once per (source, reference)', () => {
  it('answers a retry with what was given, and gives nothing again', async () => {
    const { tx, issues } = fakeTx({ grants: [grant('g-a')] });
    const first = await issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 1)));
    const again = await issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 1)));
    expect(again).toMatchObject({ rewardId: first.rewardId, grantId: 'g-a', replay: true });
    expect(adjustGrantTraffic).toHaveBeenCalledTimes(1);
    expect(issues).toHaveLength(1);
  });

  it('refuses the same reference for another user or prize', async () => {
    const { tx } = fakeTx({ grants: [grant('g-a')] });
    await issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 1)));
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.extra_days, 1)))).rejects.toMatchObject({ reason: 'reference_reused' });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 1), { userId: 'someone-else' }))).rejects.toMatchObject({ reason: 'reference_reused' });
  });

  it('keeps the lottery and the wheel apart', async () => {
    const { tx } = fakeTx({ grants: [grant('g-a')] });
    await issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 1)));
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.bonus_traffic_gb, 1), { source: RewardSource.lottery }))).resolves.toMatchObject({ replay: false });
  });
});

describe('no cash (point 2)', () => {
  it('refuses a wallet credit, and an empty slot is nothing to issue', async () => {
    const { tx, issues } = fakeTx({ grants: [grant('g-a')] });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.wallet_credit, 5)))).rejects.toBeInstanceOf(RewardRefused);
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.wallet_credit, 5)))).rejects.toMatchObject({ reason: 'no_cash' });
    await expect(issueReward(tx, grants, input(prize(SpinPrizeType.empty, 0), { referenceId: 'att-2' }))).rejects.toThrow(RangeError);
    expect(issues).toEqual([]);
  });
});
