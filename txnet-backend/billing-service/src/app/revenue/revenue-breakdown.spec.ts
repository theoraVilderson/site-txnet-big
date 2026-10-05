/**
 * A reseller's revenue split by product and by day (F-117-h, ADR-0104 (2)(3)):
 * `GET /api/billing/tenants/:tenantId/revenue/breakdown`.
 *
 * Tier A: the platform's staff read a reseller's figures as a business, with
 * no consent — so a figure must never be one that can be tied to a person.
 * The ways that breaks are quiet:
 *
 *  - **a cell of one buyer shown to the platform.** A product only one person
 *    bought, or a day only one person paid on, is that person's spending. A
 *    cell under 5 people reads `fewer_than_5`, with no count and no money;
 *  - **the reseller's own figures hidden from it.** Those are its people; the
 *    rule is for the platform (ADR-0104 (2)), so its owner sees every cell;
 *  - **the whole reseller suppressed.** Totals for the whole reseller are not
 *    (ADR-0104 (3)): its `people` is always a number;
 *  - **a name or a user id in the answer.** Cells carry a product id or a day,
 *    never who;
 *  - **the scope written by hand.** The query reads `current_tenant_id()`, the
 *    value RLS reads, bound by `ResellerAccess.run` — no tenant id is passed;
 *  - **days in the wrong zone.** A day is the reseller's (`tenant.timezone`).
 */
import { Prisma, WalletReasonType } from '@prisma/client';
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';

import { ResellerRevenueRefused, ResellerRevenueService } from './reseller-revenue.service';
import { BreakdownRow, SMALL_GROUP } from './revenue-breakdown';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const STAFF_USER = '66666666-6666-4666-8666-666666666666';
const PRODUCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[] };
const stranger = { userId: STRANGER, tenantId: PLATFORM, permissions: [] as string[] };
const staff = { userId: STAFF_USER, tenantId: PLATFORM, permissions: ['tenant.manage'] };

const FROM = new Date('2026-09-01T00:00:00.000Z');
const TO = new Date('2026-09-30T00:00:00.000Z');

const d = (v: string) => new Prisma.Decimal(v);
const row = (r: Partial<BreakdownRow> & Pick<BreakdownRow, 'dim'>): BreakdownRow => ({
  perCurrency: false,
  productId: null,
  day: null,
  currencyCode: null,
  net: null,
  count: 0,
  people: 0,
  ...r,
});

/** Product A: 6 people; product B: 3; unattributed: 1. Day 1: 7 people; day 2: 2. The reseller: 9. */
const ROWS: BreakdownRow[] = [
  row({ dim: 'all', people: 9, count: 14 }),
  row({ dim: 'product', productId: PRODUCT_A, people: 6, count: 8 }),
  row({ dim: 'product', productId: PRODUCT_A, perCurrency: true, currencyCode: 'USD', net: d('80.00'), count: 8 }),
  row({ dim: 'product', productId: PRODUCT_B, people: 3, count: 4 }),
  row({ dim: 'product', productId: PRODUCT_B, perCurrency: true, currencyCode: 'USD', net: d('40.00'), count: 4 }),
  row({ dim: 'product', productId: null, people: 1, count: 2 }),
  row({ dim: 'product', productId: null, perCurrency: true, currencyCode: 'USD', net: d('20.00'), count: 2 }),
  row({ dim: 'day', day: '2026-09-02', people: 2, count: 3 }),
  row({ dim: 'day', day: '2026-09-02', perCurrency: true, currencyCode: 'USD', net: d('30.00'), count: 3 }),
  row({ dim: 'day', day: '2026-09-01', people: 7, count: 11 }),
  row({ dim: 'day', day: '2026-09-01', perCurrency: true, currencyCode: 'USD', net: d('110.00'), count: 11 }),
];

type Seen = { sql: string; values: unknown[]; scope: string | undefined };

function build(rows: BreakdownRow[] = ROWS, opts: { currencyCode?: string; changes?: { fromCode: string; toCode: string; rate: string }[] } = {}) {
  const seen: Seen[] = [];
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
  const places: Record<string, number> = { USD: 2, IRR: 0 };
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      seen.push({ sql: strings.join('?'), values, scope: TenantContext.currentOrNull()?.id });
      return rows;
    },
    tenant: { findUnique: async () => ({ operatingCurrencyCode: opts.currencyCode ?? 'USD', timezone: 'Asia/Tehran' }) },
    currency: { findUnique: async ({ where }: { where: { code: string } }) => (where.code in places ? { decimalPlaces: places[where.code] } : null) },
    currencyChange: { findMany: async () => (opts.changes ?? []).map((c) => ({ ...c, rate: d(c.rate) })) },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  return { seen, service: new ResellerRevenueService(prisma as never, access, {} as never) };
}

describe('ResellerRevenueService.breakdown', () => {
  it('refuses a stranger before any ledger is read', async () => {
    const { seen, service } = build();
    await expect(service.breakdown(stranger, RESELLER, { from: FROM, to: TO })).rejects.toBeInstanceOf(ResellerRevenueRefused);
    expect(seen).toEqual([]);
  });

  it("shows the platform's staff 'fewer than 5' for a cell under 5 people, with no count and no money", async () => {
    const { service } = build();
    const b = await service.breakdown(staff, RESELLER, { from: FROM, to: TO });

    expect(SMALL_GROUP).toBe(5);
    expect(b.suppressed).toBe(true);
    expect(b.byProduct).toEqual([
      { productId: PRODUCT_A, people: 6, count: 8, total: '80.00', byCurrency: [{ currencyCode: 'USD', total: '80.00', count: 8 }] },
      { productId: PRODUCT_B, people: 'fewer_than_5', count: null, total: null, byCurrency: [] },
      { productId: null, people: 'fewer_than_5', count: null, total: null, byCurrency: [] },
    ]);
    // One day hidden alone would be the total minus the other: both are hidden (F-117-i).
    expect(b.trend).toEqual([
      { day: '2026-09-01', people: 'fewer_than_5', count: null, total: null, byCurrency: [] },
      { day: '2026-09-02', people: 'fewer_than_5', count: null, total: null, byCurrency: [] },
    ]);
  });

  it('never suppresses the whole reseller', async () => {
    const { service } = build([row({ dim: 'all', people: 2, count: 3 })]);
    const b = await service.breakdown(staff, RESELLER, { from: FROM, to: TO });
    expect(b.people).toBe(2);
    expect(b.count).toBe(3);
  });

  it("shows the reseller's own people every cell, small ones included", async () => {
    const { service } = build();
    const b = await service.breakdown(owner, RESELLER, { from: FROM, to: TO });
    expect(b.suppressed).toBe(false);
    expect(b.byProduct.find((c) => c.productId === PRODUCT_B)).toEqual({
      productId: PRODUCT_B, people: 3, count: 4, total: '40.00', byCurrency: [{ currencyCode: 'USD', total: '40.00', count: 4 }],
    });
    expect(b.trend.map((c) => c.people)).toEqual([7, 2]);
  });

  it("reads in the reseller's scope through current_tenant_id(), passing no tenant id, in its time zone", async () => {
    const { seen, service } = build();
    const b = await service.breakdown(owner, RESELLER, { from: FROM, to: TO });

    expect(seen).toHaveLength(1);
    expect(seen[0].scope).toBe(RESELLER);
    expect(seen[0].sql).toContain('public.current_tenant_id()');
    expect(seen[0].values).not.toContain(RESELLER);
    expect(seen[0].values).toContain('Asia/Tehran');
    expect(b.timeZone).toBe('Asia/Tehran');
    // The same sale and refund reasons the totals count, bound — never spelled in the SQL.
    expect(seen[0].values).toContainEqual([WalletReasonType.traffic_consumption, WalletReasonType.product_purchase, WalletReasonType.usage_charge]);
    expect(seen[0].values).toContainEqual([WalletReasonType.traffic_refund, WalletReasonType.product_refund, WalletReasonType.usage_refund]);
    // Nobody is named: cells carry a product or a day.
    expect(JSON.stringify(b)).not.toMatch(/userId|ownerUserId|person/);
  });

  it('converts each currency into the reseller\'s own and keeps what was written', async () => {
    const { service } = build(
      [
        row({ dim: 'all', people: 6, count: 2 }),
        row({ dim: 'product', productId: PRODUCT_A, people: 6, count: 2 }),
        row({ dim: 'product', productId: PRODUCT_A, perCurrency: true, currencyCode: 'IRR', net: d('500000.00'), count: 1 }),
        row({ dim: 'product', productId: PRODUCT_A, perCurrency: true, currencyCode: 'USD', net: d('10.00'), count: 1 }),
      ],
      { currencyCode: 'USD', changes: [{ fromCode: 'IRR', toCode: 'USD', rate: '0.00002' }] },
    );
    const b = await service.breakdown(staff, RESELLER, { from: FROM, to: TO });
    expect(b.currencyCode).toBe('USD');
    expect(b.byProduct[0]).toMatchObject({
      total: '20.00',
      byCurrency: [
        { currencyCode: 'IRR', total: '500000.00', count: 1 },
        { currencyCode: 'USD', total: '10.00', count: 1 },
      ],
    });
  });
});

/**
 * F-117-i: one hidden cell is not hidden. The `/revenue` total minus the shown
 * cells is exactly its money, so when a split hides one cell the next smallest
 * shown cell is hidden with it — two cells' sum names no one group.
 */
describe('ResellerRevenueService.breakdown — complementary suppression (F-117-i)', () => {
  const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const product = (productId: string | null, people: number, count: number, net: string) => [
    row({ dim: 'product', productId, people, count }),
    row({ dim: 'product', productId, perCurrency: true, currencyCode: 'USD', net: d(net), count }),
  ];
  const day = (dayKey: string, people: number, count: number, net: string) => [
    row({ dim: 'day', day: dayKey, people, count }),
    row({ dim: 'day', day: dayKey, perCurrency: true, currencyCode: 'USD', net: d(net), count }),
  ];

  it('hides the smallest shown product too when only one product was hidden', async () => {
    const { service } = build([
      row({ dim: 'all', people: 20, count: 30 }),
      ...product(PRODUCT_A, 12, 15, '150.00'),
      ...product(PRODUCT_B, 6, 9, '90.00'),
      ...product(C, 2, 6, '60.00'),
    ]);
    const b = await service.breakdown(staff, RESELLER, { from: FROM, to: TO });
    expect(b.byProduct.map((c) => [c.productId, c.people])).toEqual([
      [PRODUCT_A, 12],
      [PRODUCT_B, 'fewer_than_5'],
      [C, 'fewer_than_5'],
    ]);
  });

  it('does the same for days, and leaves a split with two or more hidden cells alone', async () => {
    const { service } = build([
      row({ dim: 'all', people: 20, count: 30 }),
      ...product(PRODUCT_A, 3, 4, '40.00'),
      ...product(PRODUCT_B, 2, 2, '20.00'),
      ...product(C, 15, 24, '240.00'),
      ...day('2026-09-01', 8, 10, '100.00'),
      ...day('2026-09-02', 9, 12, '120.00'),
      ...day('2026-09-03', 1, 8, '80.00'),
    ]);
    const b = await service.breakdown(staff, RESELLER, { from: FROM, to: TO });
    expect(b.byProduct.filter((c) => c.people === 'fewer_than_5').map((c) => c.productId).sort()).toEqual([PRODUCT_A, PRODUCT_B].sort());
    expect(b.byProduct.find((c) => c.productId === C)?.people).toBe(15);
    expect(b.trend.map((c) => c.people)).toEqual(['fewer_than_5', 9, 'fewer_than_5']);
  });

  it("never applies to the reseller's own people", async () => {
    const { service } = build([row({ dim: 'all', people: 14, count: 20 }), ...product(PRODUCT_A, 12, 15, '150.00'), ...product(PRODUCT_B, 2, 5, '50.00')]);
    const b = await service.breakdown(owner, RESELLER, { from: FROM, to: TO });
    expect(b.byProduct.map((c) => c.people)).toEqual([12, 2]);
  });
});

/**
 * F-117-j: the complement is chosen per currency. `/revenue` answers each
 * currency's total on its own, so a hidden cell that is the only hidden one
 * holding a currency is that currency's total minus the shown cells — even
 * when another cell, in another currency, is hidden beside it.
 */
describe('ResellerRevenueService.breakdown — complement per currency (F-117-j)', () => {
  const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const cell = (productId: string, people: number, count: number, money: Record<string, string>) => [
    row({ dim: 'product', productId, people, count }),
    ...Object.entries(money).map(([currencyCode, net]) => row({ dim: 'product', productId, perCurrency: true, currencyCode, net: d(net), count: 1 })),
  ];
  const changes = [{ fromCode: 'IRR', toCode: 'USD', rate: '0.00002' }];
  const hiddenOf = (b: { byProduct: { productId: string | null; people: number | string }[] }) =>
    b.byProduct.filter((c) => c.people === 'fewer_than_5').map((c) => c.productId).sort();

  it('two hidden cells in two currencies each take a shown cell of their own currency', async () => {
    const { service } = build(
      [
        row({ dim: 'all', people: 40, count: 60 }),
        ...cell(PRODUCT_A, 2, 3, { USD: '30.00' }),
        ...cell(PRODUCT_B, 3, 4, { IRR: '400000.00' }),
        ...cell(C, 20, 30, { USD: '300.00' }),
        ...cell(D, 9, 12, { IRR: '1200000.00' }),
        ...cell(E, 6, 11, { USD: '110.00' }),
      ],
      { changes },
    );
    const b = await service.breakdown(staff, RESELLER, { from: FROM, to: TO });
    // E is the smallest shown USD cell, D the only shown IRR one; C stays.
    expect(hiddenOf(b)).toEqual([PRODUCT_A, PRODUCT_B, D, E].sort());
  });

  it('a complement that brings a new currency in is paired in that currency too', async () => {
    const { service } = build(
      [
        row({ dim: 'all', people: 40, count: 60 }),
        ...cell(PRODUCT_A, 2, 3, { USD: '30.00' }),
        ...cell(C, 6, 8, { USD: '80.00', IRR: '100000.00' }),
        ...cell(D, 9, 12, { IRR: '1200000.00' }),
        ...cell(E, 20, 30, { USD: '300.00' }),
      ],
      { changes },
    );
    const b = await service.breakdown(staff, RESELLER, { from: FROM, to: TO });
    // A takes C (smallest shown USD); C is then the only hidden IRR cell, so D goes too.
    expect(hiddenOf(b)).toEqual([PRODUCT_A, C, D].sort());
  });

  it('leaves alone a currency already hidden in two cells', async () => {
    const { service } = build(
      [
        row({ dim: 'all', people: 40, count: 60 }),
        ...cell(PRODUCT_A, 2, 3, { USD: '30.00' }),
        ...cell(PRODUCT_B, 3, 4, { USD: '40.00' }),
        ...cell(C, 20, 30, { USD: '300.00' }),
      ],
    );
    const b = await service.breakdown(staff, RESELLER, { from: FROM, to: TO });
    expect(hiddenOf(b)).toEqual([PRODUCT_A, PRODUCT_B].sort());
  });
});
