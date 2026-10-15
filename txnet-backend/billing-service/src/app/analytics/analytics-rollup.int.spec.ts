/**
 * The analytics rollup against a real Postgres (F-1001-a,
 * billing/contract.analytics.md principle 2 and "The worker").
 *
 * The rollup is SQL, so only a database can prove what matters about it:
 *
 *  - **net sales is `/revenue`'s `sales.total` to the cent**, for the same
 *    tenant and window. Two figures of one thing that disagree are the bug
 *    principle 2 exists for; both are read here, through the real service;
 *  - **a refund comes off the sale it undoes**, and a top-up, a gift and a
 *    transfer are never a sale;
 *  - **another tenant's ledger is never summed in** — the scope is
 *    `current_tenant_id()`, bound by `tenantTransaction`;
 *  - **a second pass changes nothing**: no second event, no version bump —
 *    and a pass after a new sale writes exactly one.
 *
 *   npm run test:int
 */
import { PrismaClient } from '@prisma/client';
import { AdmittedReseller, ResellerAccess, runWithTenant, withTenant } from '@txnet-backend/shared-core';

import { HARNESS_TIMEOUT_MS, PostgresFixture, prismaAt, startPostgresFixture } from '../../../../test-support/postgres-fixture';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { ResellerRevenueService } from '../revenue/reseller-revenue.service';
import { dayBounds } from './analytics-days';
import { AnalyticsRollupService } from './analytics-rollup.service';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ROLE_ID = '33333333-3333-4333-8333-333333333333';
const USER_1 = '44444444-4444-4444-8444-444444444441';
const USER_2 = '44444444-4444-4444-8444-444444444442';
const USER_B = '44444444-4444-4444-8444-444444444443';
const ZONE = 'Asia/Tehran';
const DAY_1 = '2026-09-01';
const DAY_2 = '2026-09-02';
/** 23:00 in Tehran on day 2: the window ends today, so the pass writes today's stock too. */
const NOW = new Date('2026-09-02T19:30:00Z');

let pg: PostgresFixture;
let app: PrismaService;
let owner: PrismaClient;
let rollup: AnalyticsRollupService;
let revenue: ResellerRevenueService;

beforeAll(async () => {
  pg = await startPostgresFixture();
  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
  owner = prismaAt(pg.ownerUrl);
  await seed();
  rollup = new AnalyticsRollupService(app, owner as unknown as CrossTenantPrismaService);
  // The door is not what this file is about: it admits the reseller's owner and runs the work in its scope.
  const door = {
    for: () => ({
      runFiguresIncludingPlatform: (_actor: unknown, tenantId: string, _cap: string, work: (r: AdmittedReseller) => Promise<unknown>) =>
        runWithTenant({ id: tenantId }, () => work({ id: tenantId, slug: 'alpha', as: 'owner' })),
    }),
  } as unknown as ResellerAccess;
  revenue = new ResellerRevenueService(app, door, owner as unknown as CrossTenantPrismaService);
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

async function seed() {
  await owner.$executeRawUnsafe(`INSERT INTO identity.role (id, name, "isSystemRole") VALUES ('${ROLE_ID}', 'harness_user', false)`);
  for (const [id, slug] of [[TENANT_A, 'alpha'], [TENANT_B, 'beta']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", timezone, "operatingCurrencyCode", "updatedAt")
      VALUES ('${id}', 'reseller', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', '${ZONE}', 'USD', now())`);
  }
  for (const [user, tenant] of [[USER_1, TENANT_A], [USER_2, TENANT_A], [USER_B, TENANT_B]]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
      VALUES ('${user}', '${tenant}', 'person', 'x', '${ROLE_ID}', now())`);
    await owner.$executeRawUnsafe(`
      INSERT INTO billing.wallet (id, "ownerUserId", "currencyCode", "cachedBalance", version) VALUES ('${user}', '${user}', 'USD', 0, 0)`);
  }
  // Day 1 in Tehran, though 2026-08-31 in UTC: the zone is what cuts the day.
  await entry(USER_1, TENANT_A, 'debit', 'product_purchase', '30.00', '2026-08-31T21:00:00Z');
  await entry(USER_1, TENANT_A, 'debit', 'traffic_consumption', '10.00', '2026-09-01T08:00:00Z');
  await entry(USER_1, TENANT_A, 'credit', 'traffic_refund', '4.00', '2026-09-02T08:00:00Z');
  await entry(USER_2, TENANT_A, 'debit', 'usage_charge', '5.25', '2026-09-02T09:00:00Z');
  // Money moving without a sale.
  await entry(USER_2, TENANT_A, 'credit', 'payment_gateway', '100.00', '2026-09-01T09:00:00Z');
  await entry(USER_2, TENANT_A, 'credit', 'coupon_redemption', '7.00', '2026-09-01T10:00:00Z');
  await entry(USER_2, TENANT_A, 'debit', 'wallet_transfer_out', '3.00', '2026-09-01T11:00:00Z');
  // Another tenant's sale, the same day.
  await entry(USER_B, TENANT_B, 'debit', 'product_purchase', '99.00', '2026-09-01T08:00:00Z');
}

function entry(user: string, tenant: string, direction: string, reason: string, amount: string, at: string) {
  return owner.$executeRawUnsafe(`
    INSERT INTO billing.wallet_transaction (id, "walletId", "tenantId", amount, direction, "reasonType", "balanceAfter", "currencyCode", "createdAt")
    VALUES (gen_random_uuid(), '${user}', '${tenant}', ${amount}, '${direction}', '${reason}', 0, 'USD', '${at}')`);
}

const sumNet = async () => {
  const [row] = await owner.$queryRawUnsafe<{ net: string | null }[]>(
    `SELECT SUM(net)::text AS net FROM billing.analytics_sales_day WHERE "tenantId" = '${TENANT_A}' AND day BETWEEN '${DAY_1}' AND '${DAY_2}'`,
  );
  return row?.net;
};

const refreshed = () => owner.outboxEvent.findMany({ where: { type: 'billing.analytics.refreshed', aggregateId: TENANT_A } });

describe('the analytics rollup (F-1001-a)', () => {
  it('net sales over the window equals /revenue sales.total for the same window, to the cent', async () => {
    expect(await rollup.rollup(TENANT_A, DAY_1, DAY_2, NOW)).toBe(true);

    const { from, to } = dayBounds(DAY_1, DAY_2, ZONE);
    const totals = await revenue.totals({ userId: TENANT_A, tenantId: TENANT_A, permissions: [] }, TENANT_A, { from, to: new Date(to.getTime() - 1) });

    expect(await sumNet()).toBe('41.25');
    expect(totals.sales.total).toBe('41.25');
  });

  it('splits by kind and day in the tenant zone, a refund off its own sale', async () => {
    const rows = await owner.analyticsSalesDay.findMany({ where: { tenantId: TENANT_A }, orderBy: [{ day: 'asc' }, { kind: 'asc' }] });
    const shape = rows.map((r) => [r.day.toISOString().slice(0, 10), r.kind, r.gross.toFixed(2), r.refunds.toFixed(2), r.net.toFixed(2), r.orders]);
    expect(shape).toEqual([
      [DAY_1, 'package', '30.00', '0.00', '30.00', 1],
      [DAY_1, 'usage', '10.00', '0.00', '10.00', 0],
      [DAY_2, 'usage', '5.25', '4.00', '1.25', 0],
    ]);
  });

  it('counts each buyer on their days, the first purchase once, and gifts apart from sales', async () => {
    const users = await owner.analyticsUserDay.findMany({ where: { tenantId: TENANT_A }, orderBy: [{ day: 'asc' }, { userId: 'asc' }] });
    expect(users.map((u) => [u.day.toISOString().slice(0, 10), u.userId, u.net.toFixed(2), u.firstPurchase])).toEqual([
      [DAY_1, USER_1, '40.00', true],
      [DAY_2, USER_1, '-4.00', false],
      [DAY_2, USER_2, '5.25', true],
    ]);
    const gifts = await owner.analyticsPaymentDay.findMany({ where: { tenantId: TENANT_A } });
    expect(gifts.map((g) => [g.gatewayKind, g.giftsCredited.toFixed(2)])).toEqual([[null, '7.00']]);
  });

  it('never rolls another tenant in', async () => {
    expect(await owner.analyticsSalesDay.count({ where: { tenantId: TENANT_B } })).toBe(0);
  });

  it('a second pass changes nothing: no event, no version bump; a new sale writes exactly one', async () => {
    const before = await owner.analyticsRollupState.findUniqueOrThrow({ where: { tenantId: TENANT_A } });
    expect(await refreshed()).toHaveLength(1);

    expect(await rollup.rollup(TENANT_A, DAY_1, DAY_2, NOW)).toBe(false);
    expect(await refreshed()).toHaveLength(1);
    expect((await owner.analyticsRollupState.findUniqueOrThrow({ where: { tenantId: TENANT_A } })).version).toBe(before.version);

    await entry(USER_2, TENANT_A, 'debit', 'traffic_consumption', '2.00', '2026-09-02T10:00:00Z');
    expect(await rollup.rollup(TENANT_A, DAY_1, DAY_2, NOW)).toBe(true);
    const events = await refreshed();
    expect(events).toHaveLength(2);
    expect(events[1].payload).toEqual({ tenantId: TENANT_A, from: DAY_1, to: DAY_2 });
    expect(await sumNet()).toBe('43.25');
  });

});
