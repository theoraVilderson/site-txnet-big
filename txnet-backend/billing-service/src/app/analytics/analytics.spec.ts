/**
 * The analytics tabs (F-1001-b, billing/contract.analytics.md "Read routes").
 *
 * The ways this goes wrong quietly:
 *
 *  - **a series cut the wrong way.** The server chooses day / week / month by
 *    the window's length; a Jalali reader's week starts on Saturday and month
 *    on the 1st of the Jalali month; the previous window aligns by index;
 *  - **a delta that divides by zero.** `new` when the previous was 0, `null`
 *    with nothing compared — never Infinity;
 *  - **half-built figures.** While a rebuild runs, a read answers
 *    `rebuilding` and no number at all;
 *  - **a stale answer, or a stale "updated".** The cache is keyed by the
 *    rollup version; `refreshedAt` is read fresh even on a hit;
 *  - **a person in the platform's view of a reseller.** A product of fewer
 *    than 5 buyers, and the one it would be the difference of, are hidden from
 *    the platform's staff (ADR-0104 (3)); the reseller's owner sees them all.
 */
import { Prisma } from '@prisma/client';
import { ResellerAccess } from '@txnet-backend/shared-core';

import { bucketsOf, granularityFor, previousRange } from './analytics-buckets';
import { contextOf } from './analytics-context';
import { deltaOf } from './analytics-figures';
import { AnalyticsRefused, AnalyticsService } from './analytics.service';
import { AnalyticsQuery, analyticsQuerySchema } from './analytics.schema';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const STAFF_USER = '66666666-6666-4666-8666-666666666666';
const PRODUCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PANEL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[] };
const stranger = { userId: STRANGER, tenantId: PLATFORM, permissions: [] as string[] };
const staff = { userId: STAFF_USER, tenantId: PLATFORM, permissions: ['platform.report.read'] };

const d = (v: string) => new Prisma.Decimal(v);
const query = (q: Partial<AnalyticsQuery> = {}): AnalyticsQuery => analyticsQuerySchema.parse({ from: '2026-09-01', to: '2026-09-30', ...q });

/** A sales row of the rollup read, every split null unless named. */
const sale = (r: Record<string, unknown>) => ({ bucket: null, kind: null, productId: null, panelId: null, currencyCode: 'USD', gross: d('0'), refunds: d('0'), net: d('0'), orders: 0, bytesSold: BigInt(0), discounts: d('0'), ...r });

/** Answers each rollup read by the table it reads and whether it splits by product. */
function rollupReads(sql: string) {
  if (sql.includes('SELECT DISTINCT')) return [{ productId: PRODUCT_A, panelId: PANEL }, { productId: PRODUCT_B, panelId: null }];
  const byProduct = /"productId" AS "productId"/.test(sql);
  if (sql.includes('analytics_sales_day'))
    return byProduct
      ? [sale({ productId: PRODUCT_A, net: d('80.00'), orders: 2 }), sale({ productId: PRODUCT_B, net: d('10.00'), orders: 1 })]
      : [sale({ gross: d('100.00'), refunds: d('10.00'), net: d('90.00'), orders: 3, discounts: d('5.00') })];
  if (sql.includes('analytics_user_day'))
    return byProduct ? [{ productId: PRODUCT_A, buyers: 6, newBuyers: 2 }, { productId: PRODUCT_B, buyers: 3, newBuyers: 1 }] : [{ buyers: 9, newBuyers: 4 }];
  if (sql.includes('analytics_payment_day'))
    return [{ bucket: null, gatewayKind: /"gatewayKind"::text/.test(sql) ? 'zarinpal' : null, currencyCode: 'USD', started: 4, settled: 3, failed: 1, settledAmount: d('50.00'), giftsCredited: d('7.00') }];
  if (sql.includes('analytics_stock_day')) return [{ productId: null, panelId: null, activeGrants: 12, bytesUsed: BigInt(1000) }];
  return [];
}

function build(state: { version: number; refreshedAt: Date | null; rebuildingSince: Date | null } | null = { version: 3, refreshedAt: new Date('2026-09-30T10:00:00Z'), rebuildingSince: null }) {
  const reads: string[] = [];
  const tenants: Record<string, unknown> = {
    [PLATFORM]: { id: PLATFORM, slug: 'platform', tenantType: 'platform_owner', ownerUserId: null, status: 'active', graceEndsAt: null, deletedAt: null },
    [RESELLER]: { id: RESELLER, slug: 'acme', tenantType: 'reseller', ownerUserId: OWNER_USER, status: 'active', graceEndsAt: null, deletedAt: null },
  };
  const access = new ResellerAccess({
    tenant: { findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null, findFirst: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null },
    tenantStaffMember: { findFirst: async () => null },
  } as never);
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...(values as Prisma.Sql[])).sql;
      reads.push(sql);
      return rollupReads(sql);
    },
    analyticsRollupState: { findUnique: async () => state },
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'USD' }) },
    product: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, nameKey: `product.${id.slice(0, 1)}.name` })) },
    panel: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, name: 'Frankfurt 1' })) },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  const store = new Map<string, string>();
  const redis = { get: async (k: string) => store.get(k) ?? null, setWithTtl: async (k: string, v: string) => void store.set(k, v) };
  return { reads, store, service: new AnalyticsService(prisma as never, access, redis as never) };
}

describe('the analytics query', () => {
  it('refuses a window over three years, one ending before it starts, a day that does not exist, and a tenant in the query', () => {
    expect(analyticsQuerySchema.safeParse({ from: '2022-01-01', to: '2025-12-31' }).success).toBe(false);
    expect(analyticsQuerySchema.safeParse({ from: '2026-09-02', to: '2026-09-01' }).success).toBe(false);
    expect(analyticsQuerySchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(false);
    expect(analyticsQuerySchema.safeParse({ from: '2026-09-01', to: '2026-09-30', tenantId: RESELLER }).success).toBe(false);
    expect(query()).toMatchObject({ compare: 'previous', calendar: 'gregorian' });
  });
});

describe('buckets', () => {
  it('chooses day up to 62 days, week up to 26 weeks, then month', () => {
    expect(granularityFor('2026-08-01', '2026-10-01')).toBe('day');
    expect(granularityFor('2026-08-01', '2026-10-02')).toBe('week');
    expect(granularityFor('2026-01-01', '2026-07-01')).toBe('week');
    expect(granularityFor('2026-01-01', '2026-07-02')).toBe('month');
  });

  it("starts a Jalali week on Saturday and a Gregorian one on Monday, the first clipped to the window", () => {
    expect(bucketsOf('2026-10-15', '2026-10-20', 'week', 'jalali').keys).toEqual(['2026-10-15', '2026-10-17']);
    expect(bucketsOf('2026-10-15', '2026-10-20', 'week', 'gregorian').keys).toEqual(['2026-10-15', '2026-10-19']);
  });

  it('starts a Jalali month on its 1st (1 Mehr 1405 is 23 September 2026)', () => {
    expect(bucketsOf('2026-09-01', '2026-10-31', 'month', 'jalali').keys).toEqual(['2026-09-01', '2026-09-23', '2026-10-23']);
    expect(bucketsOf('2026-09-01', '2026-10-31', 'month', 'gregorian').keys).toEqual(['2026-09-01', '2026-10-01']);
  });

  it('compares with the same length just before, or the same dates a year earlier, and aligns the previous buckets by index', () => {
    expect(previousRange('2026-09-01', '2026-09-30', 'previous')).toEqual({ from: '2026-08-02', to: '2026-08-31' });
    expect(previousRange('2026-09-01', '2026-09-30', 'year')).toEqual({ from: '2025-09-01', to: '2025-09-30' });
    expect(previousRange('2026-09-01', '2026-09-30', 'none')).toBeNull();

    const c = contextOf({} as never, query({ from: '2026-09-01', to: '2026-09-03' }), { operating: 'USD', hides: false });
    expect(c.buckets).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(c.previousMap).toEqual({ days: ['2026-08-29', '2026-08-30', '2026-08-31'], keys: ['2026-09-01', '2026-09-02', '2026-09-03'] });
  });
});

describe('deltas', () => {
  it('is a ratio, `new` from zero, 0 from zero to zero, and null with nothing compared', () => {
    expect(deltaOf('120', '100')).toBe(0.2);
    expect(deltaOf('50', '0')).toBe('new');
    expect(deltaOf('0', '0')).toBe(0);
    expect(deltaOf('50', null)).toBeNull();
  });
});

describe('AnalyticsService.read', () => {
  it('refuses a stranger before the rollup is read', async () => {
    const { reads, service } = build();
    await expect(service.read(stranger, RESELLER, 'overview', query())).rejects.toBeInstanceOf(AnalyticsRefused);
    expect(reads).toEqual([]);
  });

  it('answers `rebuilding` and no figure while a rebuild runs', async () => {
    const { reads, service } = build({ version: 3, refreshedAt: null, rebuildingSince: new Date() });
    const answer = await service.read(owner, RESELLER, 'overview', query());
    expect(answer).toEqual({ tab: 'overview', query: { from: '2026-09-01', to: '2026-09-30', compare: 'previous', calendar: 'gregorian' }, refreshedAt: null, rebuilding: true });
    expect(reads).toEqual([]);
  });

  it('answers KPIs with their previous value and delta, money per currency', async () => {
    const { service } = build();
    const answer = await service.read(owner, RESELLER, 'overview', query());
    expect(answer).toMatchObject({ rebuilding: false, granularity: 'day', suppressed: false, refreshedAt: '2026-09-30T10:00:00.000Z', currencies: ['USD'] });
    expect(answer).toMatchObject({
      kpis: {
        net: { value: { USD: '90.00' }, previous: { USD: '90.00' }, delta: { USD: 0 } },
        aov: { value: { USD: '30.00' } },
        topUps: { value: { USD: '50.00' } },
        buyers: { value: 9, previous: 9, delta: 0 },
        returningBuyers: { value: 5 },
        activeGrants: { value: 12 },
        bytesUsed: { value: '1000' },
        renewal: null,
      },
    });
  });

  it('serves a second read from the cache under the same version, with refreshedAt read fresh', async () => {
    const { reads, store, service } = build();
    await service.read(owner, RESELLER, 'sales', query());
    const first = reads.length;
    expect([...store.keys()][0]).toMatch(new RegExp(`^analytics:${RESELLER}:v3:sales:`));
    const again = await service.read(owner, RESELLER, 'sales', query());
    expect(reads).toHaveLength(first);
    expect(again).toMatchObject({ rebuilding: false, refreshedAt: '2026-09-30T10:00:00.000Z', payments: { started: 4, settled: 3, successRate: 0.75 } });
  });

  it("hides from the platform's staff a product under 5 buyers and the one it would be the difference of; the owner sees both", async () => {
    const asStaff = await build().service.read(staff, RESELLER, 'overview', query());
    expect(asStaff).toMatchObject({ suppressed: true, byProduct: { top: [{ productId: PRODUCT_A, people: 'fewer_than_5' }, { productId: PRODUCT_B, people: 'fewer_than_5' }], other: null } });
    // The whole reseller is never hidden.
    expect(asStaff).toMatchObject({ kpis: { net: { value: { USD: '90.00' } } } });

    const asOwner = await build().service.read(owner, RESELLER, 'overview', query());
    expect(asOwner).toMatchObject({
      byProduct: { top: [{ productId: PRODUCT_A, net: { USD: '80.00' }, buyers: 6, share: 0.8889 }, { productId: PRODUCT_B, net: { USD: '10.00' }, buyers: 3 }] },
    });
  });

  it('names every product and panel with a row in the window — catalog keys, never text — for the filter bar and the labels (F-1001-d)', async () => {
    const answer = await build().service.read(owner, RESELLER, 'overview', query({ product: PRODUCT_A }));
    expect(answer).toMatchObject({
      names: { products: [{ id: PRODUCT_A, nameKey: 'product.a.name' }, { id: PRODUCT_B, nameKey: 'product.b.name' }], panels: [{ id: PANEL, name: 'Frankfurt 1' }] },
    });
  });

  it("gives the platform's staff no per-gateway split of a reseller's payments, only the totals", async () => {
    const answer = await build().service.read(staff, RESELLER, 'sales', query());
    expect(answer).toMatchObject({ payments: { started: 4, settled: 3, byKind: null } });
  });
});
