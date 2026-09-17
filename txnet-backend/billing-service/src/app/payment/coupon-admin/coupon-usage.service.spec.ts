/**
 * The coupon usage report (F-502-e, D-33): who used a coupon or a batch, on
 * which payment, for how much, in what state — plus the totals an admin reads
 * first.
 *
 *  - **totals say what was given, not what was held.** `discountGiven` sums
 *    confirmed redemptions only; a pending hold is `reserved`, and an expired or
 *    cancelled one gave nothing;
 *  - **a batch report is its codes' redemptions**, and none from outside it;
 *  - **a deleted coupon still reports.** Soft delete exists so its receipts stay
 *    explicable (ADR-0048 decision 6);
 *  - **reach** is coupon management's: another tenant's coupon or batch is not
 *    found.
 */
import { TenantType } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { CouponAdminRefused, CouponAdminService } from './coupon-admin.service';
import { CouponBatchService } from './coupon-batch.service';
import { CouponUsageService } from './coupon-usage.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const BATCH = '55555555-5555-4555-8555-555555555555';
const OTHER_BATCH = '66666666-6666-4666-8666-666666666666';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAY_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const actor = (tenantId: string) => ({ adminId: ADMIN, tenantId, ip: '10.0.0.9' });

type Row = Record<string, unknown>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (v !== null && typeof v === 'object' && 'in' in (v as Row)) return (v as { in: unknown[] }).in.includes(row[k]);
    return (row[k] ?? null) === v;
  });
}

/**
 * Both pools over the same rows, every call logged as `app:` or `all:` (ADR-0053),
 * and every service call run in the actor's tenant, as `identity.middleware.ts` runs it.
 */
function pools(db: object) {
  const calls: string[] = [];
  const pool = (name: string) => {
    const client: Record<string, unknown> = { $executeRaw: async () => 0 };
    for (const [model, delegate] of Object.entries(db)) {
      client[model] = Object.fromEntries(
        Object.entries(delegate as Row)
          .filter(([, fn]) => typeof fn === 'function')
          .map(([op, fn]) => [op, (...args: unknown[]) => (calls.push(`${name}:${model}.${op}`), (fn as (...a: unknown[]) => unknown)(...args))]),
      );
    }
    client['$transaction'] = async (fn: (tx: unknown) => unknown) => fn(client);
    return client;
  };
  return { app: pool('app'), all: pool('all'), calls };
}

function inTenant<T extends object>(service: T): T {
  return new Proxy(service, {
    get: (target, key) => {
      const v = Reflect.get(target, key) as unknown;
      if (typeof v !== 'function') return v;
      return (actor: { tenantId: string }, ...rest: unknown[]) => runWithTenant({ id: actor.tenantId }, () => v.call(target, actor, ...rest));
    },
  });
}

function table(rows: Row[]) {
  return {
    rows,
    findMany: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)),
    findUnique: async ({ where }: { where: Row }) => rows.find((r) => matches(r, where)) ?? null,
    count: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)).length,
    groupBy: async ({ where }: { where: Row }) => {
      const by = new Map<unknown, Row[]>();
      for (const r of rows.filter((x) => matches(x, where))) by.set(r['status'], [...(by.get(r['status']) ?? []), r]);
      return [...by.entries()].map(([status, list]) => ({
        status,
        _count: { _all: list.length },
        _sum: { discountAppliedAmount: list.reduce((a, r) => a + Number(r['discountAppliedAmount']), 0).toFixed(2) },
      }));
    },
  };
}

const redemption = (id: string, couponId: string, userId: string, status: string, amount: string, pay: string | null = null): Row => ({
  id,
  couponId,
  userId,
  status,
  discountAppliedAmount: amount,
  paymentTransactionId: pay,
  orderReferenceId: id,
  redeemedAt: new Date('2026-09-10T10:00:00Z'),
});

function build() {
  const types: Record<string, TenantType> = { [OWNER]: TenantType.platform_owner, [RESELLER]: TenantType.reseller, [OTHER]: TenantType.reseller };
  const db = {
    tenant: table(Object.entries(types).map(([id, tenantType]) => ({ id, tenantType }))),
    coupon: table([
      { id: 'c-plain', tenantId: RESELLER, code: 'NOWRUZ', batchId: null, deletedAt: new Date(), usedCount: 2, reservedCount: 1 },
      { id: 'c-b1', tenantId: RESELLER, code: 'GIFT-AAAA', batchId: BATCH, deletedAt: null, usedCount: 1, reservedCount: 0 },
      { id: 'c-b2', tenantId: RESELLER, code: 'GIFT-BBBB', batchId: BATCH, deletedAt: null, usedCount: 0, reservedCount: 0 },
      { id: 'c-other', tenantId: OTHER, code: 'THEIRS', batchId: OTHER_BATCH, deletedAt: null, usedCount: 1, reservedCount: 0 },
    ]),
    couponBatch: table([
      { id: BATCH, tenantId: RESELLER, label: 'mine' },
      { id: OTHER_BATCH, tenantId: OTHER, label: 'theirs' },
    ]),
    couponRedemption: table([
      redemption('r1', 'c-plain', USER_A, 'confirmed', '3.00', PAY_1),
      redemption('r2', 'c-plain', USER_B, 'confirmed', '2.50'),
      redemption('r3', 'c-plain', USER_A, 'pending', '4.00'),
      redemption('r4', 'c-plain', USER_B, 'expired', '9.00'),
      redemption('r5', 'c-b1', USER_A, 'confirmed', '5.00'),
      redemption('r6', 'c-other', USER_B, 'confirmed', '7.00'),
    ]),
    user: table([
      { id: USER_A, fullName: 'Sara K', username: 'sara' },
      { id: USER_B, fullName: 'Reza M', username: null },
    ]),
    paymentTransaction: table([{ id: PAY_1, status: 'success' }]),
  };
  const { app, all, calls } = pools(db);
  const coupons = new CouponAdminService(app as never, all as never);
  return Object.assign(inTenant(new CouponUsageService(coupons, new CouponBatchService(coupons))), { calls });
}

async function refusal(run: () => Promise<unknown>): Promise<CouponAdminRefused> {
  try {
    await run();
  } catch (e) {
    if (e instanceof CouponAdminRefused) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('CouponUsageService', () => {
  it('reports a coupon’s redemptions with user, payment, amount and status, and totals given only by confirmed ones', async () => {
    const report = await build().forCoupon(actor(RESELLER), 'c-plain', {});
    expect(report.total).toBe(4);
    expect(report.items.find((i) => i.id === 'r1')).toEqual({
      id: 'r1',
      couponId: 'c-plain',
      code: 'NOWRUZ',
      userId: USER_A,
      userName: 'Sara K',
      username: 'sara',
      paymentTransactionId: PAY_1,
      paymentStatus: 'success',
      discountAmount: '3.00',
      status: 'confirmed',
      redeemedAt: new Date('2026-09-10T10:00:00Z'),
    });
    expect(report.totals).toEqual({ redemptions: 4, used: 2, reserved: 1, released: 1, discountGiven: '5.50' });
  });

  it('keeps a deleted coupon reportable, since its receipts must stay explicable', async () => {
    await expect(build().forCoupon(actor(RESELLER), 'c-plain', {})).resolves.toMatchObject({ total: 4 });
  });

  it('reports a batch as its own codes’ redemptions only', async () => {
    const report = await build().forBatch(actor(RESELLER), BATCH, {});
    expect(report.items.map((i) => [i.id, i.code])).toEqual([['r5', 'GIFT-AAAA']]);
    expect(report.totals).toMatchObject({ redemptions: 1, used: 1, discountGiven: '5.00' });
  });

  it('never reports another tenant’s coupon or batch to a reseller, and does to the platform owner', async () => {
    const service = build();
    expect((await refusal(() => service.forCoupon(actor(RESELLER), 'c-other', {}))).reason).toBe('coupon_not_found');
    expect((await refusal(() => service.forBatch(actor(RESELLER), OTHER_BATCH, {}))).reason).toBe('batch_not_found');
    expect(service.calls.filter((c) => c.startsWith('all:'))).toEqual([]);
    await expect(service.forBatch(actor(OWNER), OTHER_BATCH, {})).resolves.toMatchObject({ total: 1 });
  });
});
