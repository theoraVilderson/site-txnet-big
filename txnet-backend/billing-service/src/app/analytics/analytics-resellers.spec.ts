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
 *  - **currencies summed.** A reseller selling in two currencies answers two
 *    amounts; the order is by the platform's operating currency.
 */
import { Prisma } from '@prisma/client';

import { contextOf } from './analytics-context';
import { RESELLERS_SHOWN, resellersOf } from './analytics-resellers';
import { analyticsQuerySchema } from './analytics.schema';

const ACME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BETA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const d = (v: string) => new Prisma.Decimal(v);

/** The cross-tenant reads, answered by the table each names. */
function across() {
  const reads: string[] = [];
  return {
    reads,
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...(values as Prisma.Sql[])).sql;
      reads.push(sql);
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

const ctx = (reader = across()) =>
  contextOf({} as never, analyticsQuerySchema.parse({ from: '2026-09-01', to: '2026-09-02' }), { operating: 'USD', hides: false, across: reader as never });

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

  it('reads every reseller across tenants, bounded', async () => {
    const reader = across();
    await resellersOf(ctx(reader));
    expect(reader.reads.some((sql) => sql.includes(`"tenantType" = 'reseller'`))).toBe(true);
    expect(RESELLERS_SHOWN).toBeLessThanOrEqual(100);
  });

  it('cannot run without the cross-tenant reader', async () => {
    await expect(resellersOf(contextOf({} as never, analyticsQuerySchema.parse({ from: '2026-09-01', to: '2026-09-02' }), { operating: 'USD', hides: false }))).rejects.toThrow(/cross-tenant/);
  });
});
