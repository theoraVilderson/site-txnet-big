/**
 * The wheel's settings (F-707-c, ADR-0111 point 4).
 *
 * What would break silently here, and nowhere else:
 *  - a save that changes today's wheel: a version takes effect from the
 *    tenant's next calendar day — in the tenant's zone, not UTC — so a day half
 *    spun keeps the odds it started with;
 *  - a version whose average spin costs more than the day's cap: every day
 *    would end in `empty` slots, and the odds shown to users would be a lie;
 *  - a prize that pays cash, names another tenant's coupon template, variant
 *    or user group;
 *  - an unaudited save.
 */
import { Prisma, SpinPrizeType } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { tenantDayOf } from './tenant-day';
import { WheelAdminRefused, WheelAdminService, WheelVersionInput } from './wheel-admin.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '99999999-9999-4999-8999-999999999999';
const TEMPLATE = '44444444-4444-4444-8444-444444444444';
const OTHER_TEMPLATE = '44444444-4444-4444-8444-444444444445';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const GROUP = '66666666-6666-4666-8666-666666666666';
const OTHER_GROUP = '66666666-6666-4666-8666-666666666667';
// 21:00 UTC is 00:30 the next day in Tehran (+3:30): the tenant's today is the 4th.
const AT = new Date('2026-10-03T21:00:00Z');

type Row = Record<string, unknown> & { id: string; version: number; effectiveFromDay: Date };

function build(o: { versions?: Row[] } = {}) {
  const versions: Row[] = [...(o.versions ?? [])];
  const prizes: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const tx = {
    $executeRaw: async () => 0,
    tenant: { findUnique: async () => ({ timezone: 'Asia/Tehran', operatingCurrencyCode: 'IRT' }) },
    coupon: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === TEMPLATE ? { id: TEMPLATE } : null) },
    productVariant: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === VARIANT ? { id: VARIANT } : null) },
    userGroup: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === GROUP ? { id: GROUP } : null) },
    spinWheelConfig: {
      findFirst: async () => [...versions].sort((a, b) => b.version - a.version)[0] ?? null,
      findMany: async () => [...versions].sort((a, b) => b.version - a.version).map((v) => ({ ...v, prizes: prizes.filter((p) => p.wheelConfigId === v.id) })),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `cfg-${versions.length + 1}`, createdAt: AT, ...data } as unknown as Row;
        versions.push(row);
        return row;
      },
    },
    spinWheelPrize: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        prizes.push(...data.map((p, i) => ({ id: `pz-${prizes.length + i + 1}`, ...p })));
        return { count: data.length };
      },
    },
    adminAuditLog: { create: async ({ data }: { data: Record<string, unknown> }) => audits.push(data) },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  return { service: new WheelAdminService(prisma as never, () => AT), versions, prizes, audits };
}

const asTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);
const actor = { adminId: ADMIN, tenantId: TENANT, ip: '203.0.113.9' };

const base: WheelVersionInput = {
  dailyBudgetCapAmount: '100',
  prizes: [
    { label: '1 GB', prizeType: SpinPrizeType.bonus_traffic_gb, prizeValue: '1', weight: 10, costAmount: '5', dailyStockLimit: 10 },
    { label: '10% off', prizeType: SpinPrizeType.discount_coupon, prizeValue: '10', couponTemplateId: TEMPLATE, couponValidDays: 7, weight: 20, costAmount: '2' },
    { label: 'Nothing', prizeType: SpinPrizeType.empty, prizeValue: '0', weight: 70, costAmount: '0' },
  ],
};

describe('tenantDayOf', () => {
  it('is the calendar day in the tenant’s zone, not in UTC', () => {
    expect(tenantDayOf(AT, 'Asia/Tehran').toISOString()).toBe('2026-10-04T00:00:00.000Z');
    expect(tenantDayOf(AT, 'UTC').toISOString()).toBe('2026-10-03T00:00:00.000Z');
  });
});

describe('WheelAdminService.save', () => {
  it('writes version 1 from the tenant’s next day, its prizes in order, in the tenant’s currency, audited', async () => {
    const { service, versions, prizes, audits } = build();
    const view = await asTenant(() => service.save(actor, { ...base, userGroupId: GROUP }));

    expect(versions[0]).toMatchObject({ tenantId: TENANT, version: 1, currencyCode: 'IRT', userGroupId: GROUP, createdByAdminId: ADMIN });
    expect((versions[0].effectiveFromDay as Date).toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(prizes.map((p) => [p.position, p.prizeType, p.tenantId])).toEqual([
      [1, SpinPrizeType.bonus_traffic_gb, TENANT],
      [2, SpinPrizeType.discount_coupon, TENANT],
      [3, SpinPrizeType.empty, TENANT],
    ]);
    // (10*5 + 20*2 + 70*0) / 100 = 0.90 per spin.
    expect(view.expectedCostPerSpin).toBe('0.90');
    expect(view.effectiveFromDay).toBe('2026-10-05');
    expect(audits).toEqual([expect.objectContaining({ tenantId: TENANT, adminId: ADMIN, action: 'spin_wheel_version_create', targetEntityType: 'spin_wheel_config' })]);
  });

  it('a later save is the next version, never an edit of the last', async () => {
    const { service, versions } = build({ versions: [{ id: 'cfg-old', version: 3, effectiveFromDay: new Date('2026-09-01T00:00:00Z') }] });
    await asTenant(() => service.save(actor, base));
    expect(versions.map((v) => v.version)).toEqual([3, 4]);
  });

  it.each([
    ['an average spin that costs more than the day’s cap', { dailyBudgetCapAmount: '0.50' }, 'expected_cost_over_cap'],
    ['a prize that costs more than the whole cap', { dailyBudgetCapAmount: '4', prizes: [{ label: 'big', prizeType: SpinPrizeType.bonus_traffic_gb, prizeValue: '5', weight: 1, costAmount: '5' }, base.prizes[2]] }, 'prize_cost_over_cap'],
    ['cash', { prizes: [{ label: 'cash', prizeType: SpinPrizeType.wallet_credit, prizeValue: '5', weight: 1, costAmount: '5' }, base.prizes[2]] }, 'invalid_prize'],
    ['an empty slot with a cost', { prizes: [base.prizes[0], { ...base.prizes[2], costAmount: '1' }] }, 'invalid_prize'],
    ['days that are not whole', { prizes: [{ label: 'd', prizeType: SpinPrizeType.extra_days, prizeValue: '1.5', weight: 1, costAmount: '0' }, base.prizes[2]] }, 'invalid_prize'],
    ['a coupon template that is not the tenant’s', { prizes: [{ ...base.prizes[1], couponTemplateId: OTHER_TEMPLATE }, base.prizes[2]] }, 'coupon_template_not_found'],
    ['a variant the tenant cannot see', { prizes: [{ label: 'g', prizeType: SpinPrizeType.free_grant, prizeValue: '0', variantId: OTHER_TEMPLATE, weight: 1, costAmount: '1' }, base.prizes[2]] }, 'variant_not_found'],
    ['a user group that is not the tenant’s', { userGroupId: OTHER_GROUP }, 'group_not_found'],
  ])('refuses %s, writing nothing', async (_why, patch, reason) => {
    const { service, versions, prizes, audits } = build();
    const run = asTenant(() => service.save(actor, { ...base, ...patch } as WheelVersionInput));
    await expect(run).rejects.toBeInstanceOf(WheelAdminRefused);
    await expect(run).rejects.toMatchObject({ reason });
    expect([versions, prizes, audits]).toEqual([[], [], []]);
  });
});

describe('WheelAdminService.state', () => {
  it('names the version in force today and the one waiting for a later day', async () => {
    const day = (d: string) => new Date(`${d}T00:00:00Z`);
    const { service } = build({
      versions: [
        { id: 'a', version: 1, effectiveFromDay: day('2026-09-01'), dailyBudgetCapAmount: new Prisma.Decimal(10), requiresMinTotalPurchaseAmount: null, isActive: true },
        { id: 'b', version: 2, effectiveFromDay: day('2026-10-04'), dailyBudgetCapAmount: new Prisma.Decimal(10), requiresMinTotalPurchaseAmount: null, isActive: true },
        { id: 'c', version: 3, effectiveFromDay: day('2026-10-05'), dailyBudgetCapAmount: new Prisma.Decimal(10), requiresMinTotalPurchaseAmount: null, isActive: false },
      ],
    });
    const state = await asTenant(() => service.state(actor));
    expect(state.today).toBe('2026-10-04');
    expect(state.inForce?.version).toBe(2);
    expect(state.next?.version).toBe(3);
    expect(state.history.map((v) => v.version)).toEqual([3, 2, 1]);
  });
});
