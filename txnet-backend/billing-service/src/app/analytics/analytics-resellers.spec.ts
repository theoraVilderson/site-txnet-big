/**
 * The Resellers tab (F-1001-h, billing/contract.analytics.md `resellers`):
 * the platform owner's leaderboard of every reseller, tier A (ADR-0104).
 *
 * The ways this goes wrong quietly:
 *
 *  - **a reseller reads the others.** The tab is the platform's alone; a
 *    reseller naming its own tenant is refused, never answered an empty list;
 *  - **a person through a sparkline.** A reseller's total is tier A, but a
 *    point of its sparkline under 5 buyers is a cell — hidden, and with it the
 *    point it would be the difference of;
 *  - **a reseller's money read in its own currency** (ADR-0152 (6)). Each
 *    reseller's rows are in its currency; the platform's page converts every
 *    row at its day's rate into the platform's before summing — in the query,
 *    joined by currency and day. Money no rate converts stays apart, never
 *    summed in; the order is by the platform's currency.
 */
import { Prisma } from '@prisma/client';

import { contextOf } from './analytics-context';
import { RESELLERS_SHOWN, resellersOf } from './analytics-resellers';
import { analyticsQuerySchema } from './analytics.schema';
import { currencyPlaces } from '../../../../test-support/currency-registry';

const ACME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BETA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const d = (v: string) => new Prisma.Decimal(v);

/** The cross-tenant reads, answered by the table each names. */
function across() {
  const reads: string[] = [];
  const factors: string[] = [];
  return {
    reads,
    factors,
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = Prisma.sql(strings, ...(values as Prisma.Sql[]));
      const sql = query.sql;
      reads.push(sql);
      factors.push(...query.values.filter((v): v is string[] => Array.isArray(v) && v.some((x) => /^\d+(\.\d+)?$/.test(String(x)))).flat());
      if (sql.includes('AS "code"')) return [{ code: 'USD' }, { code: 'EUR' }];
      if (sql.includes('brandName'))
        return [
          { id: ACME, name: 'Acme VPN' },
          { id: BETA, name: 'beta' },
        ];
      if (sql.includes('analytics_sales_day') && sql.includes('"bucket"'))
        return [
          { tenantId: ACME, bucket: '2026-09-01', currencyCode: 'USD', net: d('30.00') },
          { tenantId: ACME, bucket: '2026-09-02', currencyCode: 'USD', net: d('70.00') },
        ];
      if (sql.includes('analytics_sales_day'))
        return [
          { tenantId: ACME, currencyCode: 'USD', net: d('100.00'), previous: d('50.00') },
          { tenantId: BETA, currencyCode: 'USD', net: d('20.00'), previous: d('0') },
          { tenantId: BETA, currencyCode: 'EUR', net: d('9.00'), previous: null },
        ];
      if (sql.includes('analytics_user_day') && sql.includes('"bucket"'))
        return [
          { tenantId: ACME, bucket: '2026-09-01', buyers: 2 },
          { tenantId: ACME, bucket: '2026-09-02', buyers: 9 },
        ];
      if (sql.includes('analytics_user_day')) return [{ tenantId: ACME, buyers: 11 }, { tenantId: BETA, buyers: 3 }];
      if (sql.includes('analytics_payment_day')) return [{ tenantId: ACME, currencyCode: 'USD', topUps: d('80.00') }];
      if (sql.includes('analytics_stock_day')) return [{ tenantId: ACME, activeGrants: 40 }];
      return [];
    },
  };
}

/** The platform's own transaction: the rates it reads (its pins) — EUR on the window's first day only. */
const platformTx = (rates: { code: string; day: string; rate: Prisma.Decimal }[] = []) => ({ $queryRaw: async () => rates });

const ctx = (reader = across(), tx = platformTx()) =>
  contextOf(tx as never, analyticsQuerySchema.parse({ from: '2026-09-01', to: '2026-09-02' }), { operating: 'USD', hides: false, places: currencyPlaces, across: reader as never });

describe('resellersOf', () => {
  it('answers every reseller with sales, largest net first, each with its totals and delta', async () => {
    const tab = await resellersOf(ctx());
    expect(tab.currencies).toEqual(['USD', 'EUR']);
    expect(tab.resellers.map((r) => r.resellerId)).toEqual([ACME, BETA]);
    expect(tab.resellers[0]).toMatchObject({
      name: 'Acme VPN',
      net: { value: { USD: '100.00', EUR: '0.00' }, previous: { USD: '50.00', EUR: '0.00' }, delta: { USD: 1, EUR: 0 } },
      topUps: { USD: '80.00', EUR: '0.00' },
      buyers: 11,
      activeGrants: 40,
    });
    // A currency per amount, never one sum; a rise from zero is `new`.
    expect(tab.resellers[1].net.value).toEqual({ USD: '20.00', EUR: '9.00' });
    expect(tab.resellers[1].net.delta).toEqual({ USD: 'new', EUR: 'new' });
  });

  it('hides a sparkline point under 5 buyers, and the one it would be the difference of', async () => {
    const tab = await resellersOf(ctx());
    expect(tab.resellers[0].sparkline.every((p) => p === null)).toBe(true);
  });

  it("converts each reseller's money in the query, by currency and day, at that day's rate (ADR-0152 (6))", async () => {
    const reader = across();
    await resellersOf(ctx(reader, platformTx([{ code: 'EUR', day: '2026-09-01', rate: d('0.8') }])));
    const sales = reader.reads.find((sql) => sql.includes('analytics_sales_day') && sql.includes('"previous"')) ?? '';
    expect(sales).toMatch(/unnest\([\s\S]*\) AS f\("code", "day", "factor"\)/);
    expect(sales).toContain('COALESCE(f."factor", 1)');
    // One EUR = 1.25 USD on 09-01; 09-02 has no rate, so its EUR stays apart.
    expect(reader.factors).toContain('1.25');
  });

  it('reads every reseller across tenants, bounded', async () => {
    const reader = across();
    await resellersOf(ctx(reader));
    expect(reader.reads.some((sql) => sql.includes(`"tenantType" = 'reseller'`))).toBe(true);
    expect(RESELLERS_SHOWN).toBeLessThanOrEqual(100);
  });

  it('cannot run without the cross-tenant reader', async () => {
    await expect(resellersOf(contextOf({} as never, analyticsQuerySchema.parse({ from: '2026-09-01', to: '2026-09-02' }), { operating: 'USD', hides: false, places: currencyPlaces }))).rejects.toThrow(/cross-tenant/);
  });
});
