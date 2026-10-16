import { Prisma } from '@prisma/client';

import { sparkPoints } from './analytics-buckets';
import { CrossTenantReader, TabContext, dayMap } from './analytics-context';
import { Amounts, ByCurrency, MoneyKpi, amountsOf, byCurrency, currenciesOf, hiddenKeys, moneyKpi } from './analytics-figures';
import type { DayMap, Window } from './analytics-read';

/** The leaderboard's length: the largest resellers, the rest counted in `total` (C-28). */
export const RESELLERS_SHOWN = 100;
/** A reseller's sparkline: the window in this many runs of whole days, as a catalog row's. */
const SPARK_POINTS = 12;

export type ResellerRow = {
  resellerId: string;
  /** Its brand name, else its slug — the reseller as a business, tier A (ADR-0104 (2)). */
  name: string;
  net: MoneyKpi;
  topUps: Amounts;
  buyers: number;
  activeGrants: number;
  /** Net per point; a point under 5 buyers, and its complement, is `null` (ADR-0104 (3)). */
  sparkline: (Amounts | null)[];
};

export type ResellersTab = { currencies: string[]; total: number; resellers: ResellerRow[] };

/** Every live reseller — the ids every other read is narrowed to, so the platform's own rollup is never summed in. */
const RESELLERS = Prisma.sql`SELECT t."id" FROM tenant.tenant t WHERE t."tenantType" = 'reseller' AND t."deletedAt" IS NULL`;

const within = (alias: Prisma.Sql, w: Window) => Prisma.sql`${alias}."day" BETWEEN ${w.from}::date AND ${w.to}::date AND ${alias}."tenantId" IN (${RESELLERS})`;

const ids = (list: readonly string[]) => Prisma.sql`ARRAY[${Prisma.join(list.map((id) => Prisma.sql`${id}::uuid`))}]`;

type SalesRow = { tenantId: string; currencyCode: string; net: Prisma.Decimal; previous: Prisma.Decimal | null };

/** Net per reseller and currency over the window and the compared one: what the board is ordered by. */
function readNet(across: CrossTenantReader, w: Window, previous: Window | null): Promise<SalesRow[]> {
  const s = Prisma.sql`s`;
  const span = previous ? { from: previous.from < w.from ? previous.from : w.from, to: w.to } : w;
  return across.$queryRaw<SalesRow[]>`
    SELECT s."tenantId", s."currencyCode",
           COALESCE(SUM(s."net") FILTER (WHERE s."day" BETWEEN ${w.from}::date AND ${w.to}::date), 0) AS "net",
           ${previous ? Prisma.sql`COALESCE(SUM(s."net") FILTER (WHERE s."day" BETWEEN ${previous.from}::date AND ${previous.to}::date), 0)` : Prisma.sql`NULL`} AS "previous"
    FROM billing.analytics_sales_day s
    WHERE ${within(s, span)}
    GROUP BY s."tenantId", s."currencyCode"`;
}

/** The other whole-reseller figures, for the resellers shown only. */
async function readTotals(across: CrossTenantReader, w: Window, shown: readonly string[]) {
  const [p, u, k] = [Prisma.sql`p`, Prisma.sql`u`, Prisma.sql`k`];
  const topUps = await across.$queryRaw<{ tenantId: string; currencyCode: string; topUps: Prisma.Decimal }[]>`
    SELECT p."tenantId", p."currencyCode", SUM(p."settledAmount") AS "topUps" FROM billing.analytics_payment_day p
    WHERE ${within(p, w)} AND p."tenantId" = ANY(${ids(shown)}) GROUP BY p."tenantId", p."currencyCode"`;
  const buyers = await across.$queryRaw<{ tenantId: string; buyers: number }[]>`
    SELECT u."tenantId", COUNT(DISTINCT u."userId")::int AS "buyers" FROM billing.analytics_user_day u
    WHERE ${within(u, w)} AND u."tenantId" = ANY(${ids(shown)}) AND (u."net" <> 0 OR u."orders" <> 0) GROUP BY u."tenantId"`;
  // Services standing at each reseller's own last snapshot on or before the window's end.
  const stock = await across.$queryRaw<{ tenantId: string; activeGrants: number }[]>`
    SELECT DISTINCT ON (k."tenantId") k."tenantId", SUM(k."activeGrants") OVER (PARTITION BY k."tenantId", k."day")::int AS "activeGrants"
    FROM billing.analytics_stock_day k
    WHERE ${within(k, w)} AND k."tenantId" = ANY(${ids(shown)}) AND (k."activeGrants" > 0 OR k."frozenGrants" > 0)
    ORDER BY k."tenantId", k."day" DESC`;
  return { topUps, buyers: new Map(buyers.map((r) => [r.tenantId, r.buyers])), stock: new Map(stock.map((r) => [r.tenantId, r.activeGrants])) };
}

/** Net and buyers per reseller per sparkline point, for the resellers shown only. */
async function readSpark(across: CrossTenantReader, w: Window, map: DayMap, shown: readonly string[]) {
  const [s, u] = [Prisma.sql`s`, Prisma.sql`u`];
  const join = (alias: Prisma.Sql) => Prisma.sql`JOIN unnest(${map.days}::date[], ${map.keys}::date[]) AS m("day", "bucket") ON m."day" = ${alias}."day"`;
  const net = await across.$queryRaw<{ tenantId: string; bucket: string; currencyCode: string; net: Prisma.Decimal }[]>`
    SELECT s."tenantId", to_char(m."bucket", 'YYYY-MM-DD') AS "bucket", s."currencyCode", SUM(s."net") AS "net"
    FROM billing.analytics_sales_day s ${join(s)}
    WHERE ${within(s, w)} AND s."tenantId" = ANY(${ids(shown)}) GROUP BY s."tenantId", m."bucket", s."currencyCode"`;
  const buyers = await across.$queryRaw<{ tenantId: string; bucket: string; buyers: number }[]>`
    SELECT u."tenantId", to_char(m."bucket", 'YYYY-MM-DD') AS "bucket", COUNT(DISTINCT u."userId")::int AS "buyers"
    FROM billing.analytics_user_day u ${join(u)}
    WHERE ${within(u, w)} AND u."tenantId" = ANY(${ids(shown)}) AND (u."net" <> 0 OR u."orders" <> 0) GROUP BY u."tenantId", m."bucket"`;
  return { net, buyers };
}

/** One reseller's sparkline, its small points hidden as the overview's series are. */
function sparklineOf(id: string, keys: readonly string[], spark: Awaited<ReturnType<typeof readSpark>>, currencies: readonly string[]): (Amounts | null)[] {
  const net = spark.net.filter((r) => r.tenantId === id);
  const people = new Map(spark.buyers.filter((r) => r.tenantId === id).map((r) => [r.bucket, r.buyers]));
  const cells = keys.map((key) => {
    const own = net.filter((r) => r.bucket === key);
    return { key, people: people.get(key) ?? 0, count: people.get(key) ?? 0, currencies: new Set(own.map((r) => r.currencyCode)), net: byCurrency(own, (r) => r.net) };
  });
  // A point with no sale holds nobody: it is a zero, not a cell to judge.
  const hidden = hiddenKeys(cells.filter((c) => c.currencies.size > 0), true);
  return cells.map((c) => (hidden.has(c.key) ? null : amountsOf(c.net, currencies)));
}

/**
 * The platform's leaderboard of its resellers (F-1001-h): each one's net with
 * its delta, top-ups, buyers, active services and a sparkline — whole-reseller
 * totals, tier A (ADR-0104). Read across tenants, so only the platform's own
 * tab reaches it (`AnalyticsService` refuses it to any other tenant). Product,
 * panel and kind filters do not apply: a reseller's catalog is its own.
 */
export async function resellersOf(c: TabContext): Promise<ResellersTab> {
  if (!c.across) throw new Error('the resellers tab reads every reseller and needs the cross-tenant reader');
  const across = c.across;
  const names = await across.$queryRaw<{ id: string; name: string }[]>`
    SELECT t."id", COALESCE(b."brandName", t."slug") AS "name" FROM tenant.tenant t
    LEFT JOIN tenant.tenant_branding b ON b."tenantId" = t."id"
    WHERE t."tenantType" = 'reseller' AND t."deletedAt" IS NULL`;
  const sales = await readNet(across, c.window, c.previous);
  const net = (id: string, pick: (r: SalesRow) => Prisma.Decimal | null): ByCurrency => byCurrency(sales.filter((r) => r.tenantId === id), (r) => pick(r) ?? 0);
  const zero = new Prisma.Decimal(0);
  const ranked = [...new Set(sales.map((r) => r.tenantId))].sort(
    (a, b) => (net(b, (r) => r.net).get(c.operating) ?? zero).comparedTo(net(a, (r) => r.net).get(c.operating) ?? zero) || a.localeCompare(b),
  );
  const shown = ranked.slice(0, RESELLERS_SHOWN);
  const points = sparkPoints(c.window.from, c.window.to, SPARK_POINTS);
  const totals = shown.length ? await readTotals(across, c.window, shown) : null;
  const spark = shown.length ? await readSpark(across, c.window, dayMap(c.window, points.keyOf), shown) : null;
  const currencies = currenciesOf(c.operating, sales.map((r) => r.currencyCode), totals?.topUps.map((r) => r.currencyCode) ?? []);
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  return {
    currencies,
    total: names.length,
    resellers: shown.map((id) => ({
      resellerId: id,
      name: nameOf.get(id) ?? id,
      net: moneyKpi(net(id, (r) => r.net), c.previous ? net(id, (r) => r.previous) : null, currencies),
      topUps: amountsOf(byCurrency(totals?.topUps.filter((r) => r.tenantId === id) ?? [], (r) => r.topUps), currencies),
      buyers: totals?.buyers.get(id) ?? 0,
      activeGrants: totals?.stock.get(id) ?? 0,
      sparkline: spark ? sparklineOf(id, points.keys, spark, currencies) : [],
    })),
  };
}
