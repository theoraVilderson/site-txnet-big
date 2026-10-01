/**
 * A product's sales quota per package (ADR-0107 points 3, 8, 10; F-019-v6).
 * What breaks quietly:
 *
 *  - **a sale charged once per window.** Past the day and the week at once is
 *    still one sale past its quota: one price, one ledger row (user, 2026-10-01);
 *  - **a paid sale eating the free room.** A unit sold past the day does not
 *    use the week's included sales, so the statement stays explainable;
 *  - **the tightest window ignored.** The act takes the least room any window
 *    has; with `stop`, the refusal names that window's figures and writes nothing;
 *  - **an invoice for what the sale will refuse.** `admit` refuses as the sale
 *    would — an empty wallet included — and writes nothing;
 *  - **a cut mid-period.** The kinder of the locked and the live terms wins,
 *    window by window; a product taken off keeps its locked terms;
 *  - **the reseller's own product counted.** Nothing is read or written.
 */
import { Prisma, QuotaOverageMode } from '@prisma/client';

import { admitProductSale, consumeProductSale, lockProductQuotaTerms, productQuotaMeter, termsFrom, type ProductQuotaRow } from './product-quota';
import { ResellerQuotaExhausted } from './reseller-quota';

const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const PACKAGE = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '55555555-5555-4555-8555-555555555555';
const PERIOD_END = new Date('2026-10-20T00:00:00Z');
// 10:00 UTC is 13:30 in Tehran: Thursday 1 October; the week began Saturday 26 September.
const THU = new Date('2026-10-01T10:00:00Z');
const FRI = new Date('2026-10-02T10:00:00Z');

const d = (v: string) => new Prisma.Decimal(v);
const listing = (over: Partial<ProductQuotaRow> = {}): ProductQuotaRow => ({
  dayIncluded: 2,
  weekIncluded: 3,
  monthIncluded: null,
  mode: QuotaOverageMode.overage,
  unitPrice: d('2.00'),
  currencyCode: 'USD',
  ...over,
});

type Usage = { id: string; meter: string; sourceRef: string; includedQty: number; overageQty: number; overageAmount: Prisma.Decimal; releasedAt: Date | null; createdAt: Date } & Record<string, unknown>;

/** An in-memory database for one reseller selling one platform product. */
function world(opts: { row?: ProductQuotaRow | null; locks?: Array<Record<string, unknown>>; balance?: string; tenantType?: string } = {}) {
  const usage: Usage[] = [];
  const ledger: Array<{ reasonType: string; amount: Prisma.Decimal }> = [];
  const wallet = { id: 'w1', tenantId: RESELLER, cachedBalance: d(opts.balance ?? '100.00'), version: 0, currencyCode: 'USD' };
  const locksWritten: Array<{ tenantId: string; key: string; included: number | null }> = [];
  let n = 0;
  const tx = {
    $executeRaw: async () => 1,
    tenant: {
      findUnique: async () => ({ tenantType: opts.tenantType ?? 'reseller' }),
      findFirst: async () => ({ id: 'platform', operatingCurrencyCode: 'USD' }),
      findMany: async () => [{ id: RESELLER }, { id: OTHER }],
    },
    tenantSubscriptionSetting: { findUnique: async () => ({ quotaTimeZone: 'Asia/Tehran' }) },
    tenantSubscription: {
      findUnique: async () => ({ packageId: PACKAGE, currentPeriodEnd: PERIOD_END }),
      findMany: async () => [
        { tenantId: RESELLER, packageId: PACKAGE, currentPeriodEnd: PERIOD_END },
        { tenantId: OTHER, packageId: PACKAGE, currentPeriodEnd: PERIOD_END },
      ],
    },
    resellerOverageCap: { findUnique: async () => null },
    packageProduct: {
      findUnique: async () => (opts.row === null ? null : (opts.row ?? listing())),
      findMany: async () => (opts.row === null ? [] : [{ packageId: PACKAGE, productId: PRODUCT, ...(opts.row ?? listing()) }]),
    },
    resellerQuotaTermsLock: {
      findMany: async () => opts.locks ?? [],
      createMany: async ({ data }: { data: typeof locksWritten }) => (locksWritten.push(...data), { count: data.length }),
    },
    resellerQuotaUsage: {
      findUnique: async ({ where }: { where: { tenantId_meter_sourceRef: { meter: string; sourceRef: string } } }) =>
        usage.find((u) => u.meter === where.tenantId_meter_sourceRef.meter && u.sourceRef === where.tenantId_meter_sourceRef.sourceRef) ?? null,
      aggregate: async ({ where }: { where: { meter?: string; createdAt: { gte: Date; lt: Date } } }) => {
        const rows = usage.filter((u) => (!where.meter || u.meter === where.meter) && !u.releasedAt && u.createdAt >= where.createdAt.gte && u.createdAt < where.createdAt.lt);
        return { _sum: { includedQty: rows.reduce((a, r) => a + r.includedQty, 0), overageQty: rows.reduce((a, r) => a + r.overageQty, 0), overageAmount: null } };
      },
      create: async ({ data }: { data: Usage }) => (usage.push({ ...data, releasedAt: null }), data),
    },
    tenantBillingTransaction: {
      findFirst: async () => null,
      create: async ({ data }: { data: { reasonType: string; amount: Prisma.Decimal } }) => (ledger.push(data), { id: `t${++n}`, ...data }),
    },
    tenantBillingWallet: {
      findUnique: async () => ({ ...wallet }),
      updateMany: async ({ data }: { data: { cachedBalance: Prisma.Decimal } }) => ((wallet.cachedBalance = data.cachedBalance), wallet.version++, { count: 1 }),
    },
    outboxEvent: { create: async () => ({ id: 'o' }) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, usage, ledger, wallet, locksWritten };
}

const platformProduct = { id: PRODUCT, tenantId: null };
const sell = (w: ReturnType<typeof world>, ref: string, now: Date) => consumeProductSale(w.tx, { tenantId: RESELLER, product: platformProduct, sourceRef: ref, now });

describe('a sale of a product past several windows (F-019-v6)', () => {
  it('includes what every window has room for, and charges a sale past any of them once', async () => {
    const w = world();
    await sell(w, 'grant:1', THU);
    await sell(w, 'grant:2', THU);
    await sell(w, 'grant:3', THU); // past the day (2) — the week (3) still has room, but the tightest window decides
    expect(w.usage.map((u) => [u.includedQty, u.overageQty])).toEqual([[1, 0], [1, 0], [0, 1]]);
    expect(w.ledger).toEqual([expect.objectContaining({ reasonType: 'quota_overage_charge', amount: d('2.00') })]);
    expect(w.usage.every((u) => u.meter === productQuotaMeter(PRODUCT))).toBe(true);
  });

  it("does not let a sale sold past the day use the week's room, and charges a sale past both only once", async () => {
    const w = world();
    for (const ref of ['a', 'b', 'c']) await sell(w, ref, THU); // 2 included + 1 sold past the day
    await sell(w, 'd', FRI); // a new day: the week has used 2 of 3, so one more is included
    await sell(w, 'e', FRI); // past the week (3) — one sale, one charge
    expect(w.usage.map((u) => [u.sourceRef, u.includedQty, u.overageQty])).toEqual([
      ['a', 1, 0],
      ['b', 1, 0],
      ['c', 0, 1],
      ['d', 1, 0],
      ['e', 0, 1],
    ]);
    expect(w.ledger.map((l) => l.amount.toFixed(2))).toEqual(['2.00', '2.00']);
  });

  it("refuses past the tightest window with `stop`, naming its figures, and writes nothing", async () => {
    const w = world({ row: listing({ mode: QuotaOverageMode.stop, unitPrice: null, currencyCode: null }) });
    await sell(w, 'a', THU);
    await sell(w, 'b', THU);
    const e = await sell(w, 'c', THU).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ResellerQuotaExhausted);
    expect((e as ResellerQuotaExhausted).facts).toEqual({ meter: productQuotaMeter(PRODUCT), stoppedBy: 'stop', included: 2, used: 2 });
    expect(w.usage).toHaveLength(2);
  });

  it('counts every sale with no window bounded, and never charges', async () => {
    const w = world({ row: listing({ dayIncluded: null, weekIncluded: null }) });
    for (const ref of ['a', 'b', 'c', 'd']) await sell(w, ref, THU);
    expect(w.usage.map((u) => u.includedQty)).toEqual([1, 1, 1, 1]);
    expect(w.ledger).toEqual([]);
  });

  it("counts nothing for the reseller's own product or the platform's own tenant", async () => {
    const own = world();
    await consumeProductSale(own.tx, { tenantId: RESELLER, product: { id: PRODUCT, tenantId: RESELLER }, sourceRef: 'a', now: THU });
    const platform = world({ tenantType: 'platform_owner' });
    await sell(platform, 'a', THU);
    expect([own.usage, platform.usage]).toEqual([[], []]);
  });
});

describe('admitProductSale — the invoice asks before the sale (F-019-v6)', () => {
  const admit = (w: ReturnType<typeof world>) => admitProductSale(w.tx, { tenantId: RESELLER, product: platformProduct, now: THU });

  it('passes while included, and refuses as the sale would, writing nothing', async () => {
    const stop = world({ row: listing({ dayIncluded: 0, mode: QuotaOverageMode.stop, unitPrice: null, currencyCode: null }) });
    await expect(admit(stop)).rejects.toMatchObject({ stoppedBy: 'stop' });
    await expect(admit(world())).resolves.toBeUndefined();
    const short = world({ row: listing({ dayIncluded: 0 }), balance: '1.00' });
    await expect(admit(short)).rejects.toMatchObject({ stoppedBy: 'wallet_empty' });
    expect([stop.usage, short.usage, short.ledger]).toEqual([[], [], []]);
  });
});

describe('product terms held for the paid period (F-019-v6, ADR-0107 point 8)', () => {
  const lock = (window: string, included: number | null, over: Record<string, unknown> = {}) => ({
    key: `product:${PRODUCT}:${window}`,
    included,
    mode: QuotaOverageMode.overage,
    unitPrice: d('2.00'),
    currencyCode: 'USD',
    ...over,
  });

  it('takes the kinder part of locked and live, window by window', () => {
    const t = termsFrom(PRODUCT, listing({ dayIncluded: 1, weekIncluded: 10, unitPrice: d('3.00') }), [lock('day', 2), lock('week', 3), lock('month', null)]);
    expect(t?.windows).toEqual([
      { period: 'day', included: 2 },
      { period: 'week', included: 10 },
      { period: 'month', included: null },
    ]);
    expect(t?.overage).toMatchObject({ mode: 'overage', unitPrice: d('2.00') });
  });

  it('keeps a product taken off the package on its locked terms, and answers nothing for one neither listed nor held', () => {
    expect(termsFrom(PRODUCT, null, [lock('day', 2), lock('week', 3), lock('month', null)])?.windows.map((w) => w.included)).toEqual([2, 3, null]);
    expect(termsFrom(PRODUCT, null, [])).toBeNull();
  });

  it('freezes three windows per reseller of the package, and nothing already frozen this period', async () => {
    const w = world({ locks: ['day', 'week', 'month'].map((window) => ({ tenantId: OTHER, key: `product:${PRODUCT}:${window}`, periodEnd: PERIOD_END })) });
    await lockProductQuotaTerms(w.tx, { packageId: PACKAGE }, [PRODUCT]);
    expect(w.locksWritten.map((r) => [r.tenantId, r.key, r.included])).toEqual([
      [RESELLER, `product:${PRODUCT}:day`, 2],
      [RESELLER, `product:${PRODUCT}:week`, 3],
      [RESELLER, `product:${PRODUCT}:month`, null],
    ]);
  });
});
