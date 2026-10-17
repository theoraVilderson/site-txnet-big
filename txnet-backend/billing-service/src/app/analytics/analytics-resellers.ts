import { Prisma } from '@prisma/client';

import { sparkPoints } from './analytics-buckets';
import { CrossTenantReader, TabContext, dayMap } from './analytics-context';
import { daysBetween } from './analytics-days';
import { Amounts, ByCurrency, MoneyKpi, amountsOf, byCurrency, currenciesOf, hiddenKeys, moneyKpi } from './analytics-figures';
import { FxTable, fxAmount, fxCurrency, fxJoin, readFx } from './analytics-fx';
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

const [S, P, F] = [Prisma.sql`s`, Prisma.sql`p`, Prisma.sql`f`];
/** A reseller row's amount in the platform's currency, at its day's rate (ADR-0152 (6)). */
const converted = (column: Prisma.Sql) => fxAmount(column, F);
const convertedCurrency = (fx: FxTable, alias: Prisma.Sql) => fxCurrency(fx, Prisma.sql`${alias}."currencyCode"`, F);
const joined = (fx: FxTable, alias: Prisma.Sql) => fxJoin(fx, F, Prisma.sql`${alias}."currencyCode"`, Prisma.sql`${alias}."day"`);

/**
 * The factors that take every reseller's money in `span` into the platform's
 * currency: each reseller's rows are in its own (ADR-0152 (1)), the page in
 * the platform's — read with the platform's pins.
 */
async function resellersFx(c: TabContext, across: CrossTenantReader, span: Window): Promise<FxTable> {
  const codes = await across.$queryRaw<{ code: string }[]>`
    SELECT DISTINCT s."currencyCode" AS "code" FROM billing.analytics_sales_day s WHERE ${within(S, span)}
    UNION SELECT DISTINCT p."currencyCode" FROM billing.analytics_payment_day p WHERE ${within(P, span)}`;
  return readFx(c.tx, c.operating, codes.map((r) => r.code), daysBetween(span.from, span.to));
}

/** The window and the compared one together: what one read covers. */
const spanOf = (w: Window, previous: Window | null): Window => (previous ? { from: previous.from < w.from ? previous.from : w.from, to: w.to } : w);

/** Net per reseller and currency over the window and the compared one: what the board is ordered by. */
function readNet(across: CrossTenantReader, w: Window, previous: Window | null, fx: FxTable): Promise<SalesRow[]> {
  const net = converted(Prisma.sql`s."net"`);
  return across.$queryRaw<SalesRow[]>`
    SELECT s."tenantId", ${convertedCurrency(fx, S)} AS "currencyCode",
           COALESCE(SUM(${net}) FILTER (WHERE s."day" BETWEEN ${w.from}::date AND ${w.to}::date), 0) AS "net",
           ${previous ? Prisma.sql`COALESCE(SUM(${net}) FILTER (WHERE s."day" BETWEEN ${previous.from}::date AND ${previous.to}::date), 0)` : Prisma.sql`NULL`} AS "previous"
    FROM billing.analytics_sales_day s ${joined(fx, S)}
    WHERE ${within(S, spanOf(w, previous))}
    GROUP BY 1, 2`;
}

/** The other whole-reseller figures, for the resellers shown only. */
async function readTotals(across: CrossTenantReader, w: Window, shown: readonly string[], fx: FxTable) {
  const [u, k] = [Prisma.sql`u`, Prisma.sql`k`];
  const topUps = await across.$queryRaw<{ tenantId: string; currencyCode: string; topUps: Prisma.Decimal }[]>`
    SELECT p."tenantId", ${convertedCurrency(fx, P)} AS "currencyCode", SUM(${converted(Prisma.sql`p."settledAmount"`)}) AS "topUps"
    FROM billing.analytics_payment_day p ${joined(fx, P)}
    WHERE ${within(P, w)} AND p."tenantId" = ANY(${ids(shown)}) GROUP BY 1, 2`;
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
async function readSpark(across: CrossTenantReader, w: Window, map: DayMap, shown: readonly string[], fx: FxTable) {
  const u = Prisma.sql`u`;
  const join = (alias: Prisma.Sql) => Prisma.sql`JOIN unnest(${map.days}::date[], ${map.keys}::date[]) AS m("day", "bucket") ON m."day" = ${alias}."day"`;
  const net = await across.$queryRaw<{ tenantId: string; bucket: string; currencyCode: string; net: Prisma.Decimal }[]>`
    SELECT s."tenantId", to_char(m."bucket", 'YYYY-MM-DD') AS "bucket", ${convertedCurrency(fx, S)} AS "currencyCode", SUM(${converted(Prisma.sql`s."net"`)}) AS "net"
    FROM billing.analytics_sales_day s ${join(S)} ${joined(fx, S)}
    WHERE ${within(S, w)} AND s."tenantId" = ANY(${ids(shown)}) GROUP BY 1, 2, 3`;
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
  const fx = await resellersFx(c, across, spanOf(c.window, c.previous));
  const sales = await readNet(across, c.window, c.previous, fx);
  const net = (id: string, pick: (r: SalesRow) => Prisma.Decimal | null): ByCurrency => byCurrency(sales.filter((r) => r.tenantId === id), (r) => pick(r) ?? 0);
  const zero = new Prisma.Decimal(0);
  const ranked = [...new Set(sales.map((r) => r.tenantId))].sort(
    (a, b) => (net(b, (r) => r.net).get(c.operating) ?? zero).comparedTo(net(a, (r) => r.net).get(c.operating) ?? zero) || a.localeCompare(b),
  );
  const shown = ranked.slice(0, RESELLERS_SHOWN);
  const points = sparkPoints(c.window.from, c.window.to, SPARK_POINTS);
  const totals = shown.length ? await readTotals(across, c.window, shown, fx) : null;
  const spark = shown.length ? await readSpark(across, c.window, dayMap(c.window, points.keyOf), shown, fx) : null;
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
