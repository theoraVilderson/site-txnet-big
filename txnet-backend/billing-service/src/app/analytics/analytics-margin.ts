import { Prisma } from '@prisma/client';

import { CrossTenantReader, TabContext } from './analytics-context';
import { Amounts, FEWER_THAN, MoneyKpi, amountsOf, byCurrency, currenciesOf, hiddenKeys, moneyKpi } from './analytics-figures';
import { MarginCell, MoneyRow, marginCellOf, marginCellsOf } from './analytics-margin-cells';
import { AnalyticsFilters, DayMap, Window, bucketJoin, in_, productPanel, readBuyers } from './analytics-read';

/** The users listed: this many deepest losses (C-28). */
export const LOSING_USERS_SHOWN = 20;

type Split = 'product' | 'panel' | 'user';
type Hidden = { id: string | null; people: typeof FEWER_THAN };
export type ResellerMargin = MarginCell & { name: string };

export type MarginTab = {
  currencies: string[];
  totals: { net: MoneyKpi; cost: MoneyKpi; margin: MoneyKpi; marginRate: number | null; previousMarginRate: number | null };
  /** The window's cost by what it is: split by use, a panel's day with no traffic, a charge for nothing a row shows. */
  costParts: { attributed: Amounts; idle: Amounts; unallocated: Amounts };
  series: { net: Amounts[]; cost: Amounts[]; margin: Amounts[] };
  products: (MarginCell | Hidden)[];
  panels: (MarginCell | Hidden)[];
  /** The deepest losses first, each with its name (a label, read where it lives); `null` to the platform's staff on a reseller — no person is listed (ADR-0104). */
  users: (MarginCell & { name: string | null })[] | null;
  /** The platform's own only: what each reseller paid against what serving its users cost. */
  resellers: ResellerMargin[] | null;
  /** The platform's own only: panels in use in the window with no monthly cost set — their margin is not a margin. */
  noCostPanels: string[] | null;
};

/** The tenant's own cost: its own Grants' and its idle panels', never the cost of serving a reseller (that is `resellers`). */
const own = (k: Prisma.Sql) => Prisma.sql`(${k}."servedTenantId" IS NULL OR ${k}."servedTenantId" = public.current_tenant_id())`;

/** A cost in the operating currency, or in its own where no rate converted it (ADR-0149). */
const costAmount = (k: Prisma.Sql) => Prisma.sql`COALESCE(${k}."saleCost", ${k}."cost")`;
const costCurrency = (k: Prisma.Sql) => Prisma.sql`CASE WHEN ${k}."saleCost" IS NULL THEN ${k}."currencyCode" ELSE ${k}."saleCurrencyCode" END`;

const column: Record<Split, Prisma.Sql> = { product: Prisma.sql`"productId"`, panel: Prisma.sql`"panelId"`, user: Prisma.sql`"userId"` };

/** Net per split (or bucket) and currency, from the sales grain or, per user, the user grain. `kind` narrows nothing here. */
function readNet(tx: Prisma.TransactionClient, w: Window, f: AnalyticsFilters, split: Split | 'bucket' | null, map?: DayMap): Promise<MoneyRow[]> {
  const a = Prisma.sql`a`;
  const table = split === 'user' ? Prisma.sql`billing.analytics_user_day` : Prisma.sql`billing.analytics_sales_day`;
  const key = split === 'bucket' ? Prisma.sql`to_char(m."bucket", 'YYYY-MM-DD')` : split ? Prisma.sql`a.${column[split]}::text` : Prisma.sql`NULL`;
  return tx.$queryRaw<MoneyRow[]>`
    SELECT ${key} AS "key", a."currencyCode", SUM(a."net") AS "amount"
    FROM ${table} a ${bucketJoin(a, split === 'bucket' ? map : undefined)}
    WHERE ${in_(a, w)} ${productPanel(a, f)}
    GROUP BY 1, 2`;
}

/** The tenant's own cost per split (or bucket, or cost part) and currency. */
function readCost(tx: Prisma.TransactionClient, w: Window, f: AnalyticsFilters, split: Split | 'bucket' | 'part' | null, map?: DayMap): Promise<MoneyRow[]> {
  const k = Prisma.sql`k`;
  const part = Prisma.sql`CASE WHEN k."kind" = 'idle' THEN 'idle' WHEN k."productId" IS NULL THEN 'unallocated' ELSE 'attributed' END`;
  const key =
    split === 'bucket' ? Prisma.sql`to_char(m."bucket", 'YYYY-MM-DD')` : split === 'part' ? part : split ? Prisma.sql`k.${column[split]}::text` : Prisma.sql`NULL`;
  return tx.$queryRaw<MoneyRow[]>`
    SELECT ${key} AS "key", ${costCurrency(k)} AS "currencyCode", SUM(${costAmount(k)}) AS "amount"
    FROM billing.analytics_cost_day k ${bucketJoin(k, split === 'bucket' ? map : undefined)}
    WHERE ${in_(k, w)} AND ${own(k)} ${productPanel(k, f)}
    GROUP BY 1, 2`;
}

/**
 * Per reseller: what it paid the platform (its own wholesale and subscription
 * rows, in the currency charged) against what its users' traffic on the
 * platform's panels cost (the platform's rows naming it). Whole-reseller
 * totals, tier A (ADR-0104 (2)); read across tenants, the platform's own tab only.
 */
async function readResellers(across: CrossTenantReader, w: Window): Promise<{ paid: MoneyRow[]; served: MoneyRow[]; nameOf: Map<string, string> }> {
  const k = Prisma.sql`k`;
  const span = Prisma.sql`k."day" BETWEEN ${w.from}::date AND ${w.to}::date`;
  const paid = await across.$queryRaw<MoneyRow[]>`
    SELECT k."tenantId"::text AS "key", k."currencyCode", SUM(k."cost") AS "amount"
    FROM billing.analytics_cost_day k JOIN tenant.tenant t ON t."id" = k."tenantId" AND t."tenantType" = 'reseller' AND t."deletedAt" IS NULL
    WHERE ${span} AND k."kind" IN ('wholesale', 'subscription')
    GROUP BY 1, 2`;
  const served = await across.$queryRaw<MoneyRow[]>`
    SELECT k."servedTenantId"::text AS "key", ${costCurrency(k)} AS "currencyCode", SUM(${costAmount(k)}) AS "amount"
    FROM billing.analytics_cost_day k
    WHERE ${span} AND k."tenantId" = public.current_tenant_id() AND NOT ${own(k)}
    GROUP BY 1, 2`;
  const ids = [...new Set([...paid, ...served].map((r) => r.key as string))];
  const names = ids.length
    ? await across.$queryRaw<{ id: string; name: string }[]>`
        SELECT t."id"::text AS "id", COALESCE(b."brandName", t."slug") AS "name" FROM tenant.tenant t
        LEFT JOIN tenant.tenant_branding b ON b."tenantId" = t."id" WHERE t."id"::text = ANY(${ids})`
    : [];
  return { paid, served, nameOf: new Map(names.map((n) => [n.id, n.name])) };
}

/** Platform panels with a sale or a service in the window and no monthly cost on or before its end. */
async function noCostPanels(tx: Prisma.TransactionClient, w: Window): Promise<string[]> {
  const [s, k] = [Prisma.sql`s`, Prisma.sql`k`];
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT p."id"::text AS "id" FROM network.panel p
    WHERE p."ownershipType" = 'platform'
      AND p."id" IN (SELECT s."panelId" FROM billing.analytics_sales_day s WHERE ${in_(s, w)}
                     UNION SELECT k."panelId" FROM billing.analytics_stock_day k WHERE ${in_(k, w)})
      AND NOT EXISTS (SELECT 1 FROM network.panel_cost pc WHERE pc."panelId" = p."id" AND pc."effectiveFrom" <= ${w.to}::date)
    ORDER BY 1`;
  return rows.map((r) => r.id);
}

/** Each listed user named, as the Customers tab names its top customers. */
async function named(tx: Prisma.TransactionClient, cells: MarginCell[]): Promise<(MarginCell & { name: string | null })[]> {
  const ids = cells.flatMap((cell) => (cell.id ? [cell.id] : []));
  const people = ids.length ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, username: true } }) : [];
  const names = new Map(people.map((p) => [p.id, p.fullName ?? p.username ?? null]));
  return cells.map((cell) => ({ ...cell, name: names.get(cell.id ?? '') ?? null }));
}

/** A product or panel list, a cell under 5 buyers hidden from the platform's staff with its complement (ADR-0104 (3)). */
async function cellsBy(c: TabContext, split: 'product' | 'panel', currencies: string[]): Promise<(MarginCell | Hidden)[]> {
  const f = { ...c.filters, kind: undefined };
  const cells = marginCellsOf(await readNet(c.tx, c.window, f, split), await readCost(c.tx, c.window, f, split), { currencies, operating: c.operating });
  if (!c.hides) return cells;
  const people = new Map((await readBuyers(c.tx, c.window, f, [split])).map((r) => [split === 'product' ? r.productId : r.panelId, r.buyers]));
  const hidden = hiddenKeys(
    cells.map((cell) => ({ key: cell.id, people: people.get(cell.id) ?? 0, count: people.get(cell.id) ?? 0, currencies: new Set(Object.keys(cell.net)) })),
    true,
  );
  return [...cells.filter((cell) => !hidden.has(cell.id)), ...[...hidden].sort().map((id) => ({ id, people: FEWER_THAN }))];
}

/**
 * The Profit tab (F-1001-l, contract.analytics-tabs.md "Margin"): net − cost
 * for the window and the compared one, the cost by part, per bucket, per
 * product, panel and user, and for the platform per reseller. Cost is read in
 * the operating currency it was converted into (ADR-0149); `kind` does not
 * apply — a cost has no sale kind.
 */
export async function marginOf(c: TabContext): Promise<MarginTab> {
  const f = { ...c.filters, kind: undefined };
  const [net, cost] = [await readNet(c.tx, c.window, f, null), await readCost(c.tx, c.window, f, null)];
  const prev = c.previous ? { net: await readNet(c.tx, c.previous, f, null), cost: await readCost(c.tx, c.previous, f, null) } : null;
  const reseller = c.across ? await readResellers(c.across, c.window) : null;
  const currencies = currenciesOf(c.operating, [...net, ...cost, ...(prev?.net ?? []), ...(prev?.cost ?? []), ...(reseller ? [...reseller.paid, ...reseller.served] : [])].map((r) => r.currencyCode));
  const how = { currencies, operating: c.operating };

  const sum = (rows: readonly MoneyRow[]) => byCurrency(rows, (r) => r.amount);
  const marginOfRows = (n: readonly MoneyRow[], k: readonly MoneyRow[]) => {
    const [a, b] = [sum(n), sum(k)];
    return new Map(currencies.map((cur) => [cur, (a.get(cur) ?? new Prisma.Decimal(0)).minus(b.get(cur) ?? 0)]));
  };
  const parts = await readCost(c.tx, c.window, f, 'part');
  const partOf = (part: string) => amountsOf(sum(parts.filter((r) => r.key === part)), currencies);

  const [bucketNet, bucketCost] = [await readNet(c.tx, c.window, f, 'bucket', c.map), await readCost(c.tx, c.window, f, 'bucket', c.map)];
  const buckets = c.buckets.map((key) => marginCellOf(key, bucketNet.filter((r) => r.key === key), bucketCost.filter((r) => r.key === key), how));

  const users = c.hides
    ? null
    : marginCellsOf(await readNet(c.tx, c.window, f, 'user'), await readCost(c.tx, c.window, f, 'user'), how)
        .filter((cell) => cell.id !== null)
        .sort((a, b) => new Prisma.Decimal(a.margin[c.operating]).comparedTo(new Prisma.Decimal(b.margin[c.operating])) || String(a.id).localeCompare(String(b.id)))
        .slice(0, LOSING_USERS_SHOWN);
  const namedUsers = users ? await named(c.tx, users) : null;

  return {
    currencies,
    totals: {
      net: moneyKpi(sum(net), prev ? sum(prev.net) : null, currencies),
      cost: moneyKpi(sum(cost), prev ? sum(prev.cost) : null, currencies),
      margin: moneyKpi(marginOfRows(net, cost), prev ? marginOfRows(prev.net, prev.cost) : null, currencies),
      marginRate: marginCellOf(null, net, cost, how).marginRate,
      previousMarginRate: prev ? marginCellOf(null, prev.net, prev.cost, how).marginRate : null,
    },
    costParts: { attributed: partOf('attributed'), idle: partOf('idle'), unallocated: partOf('unallocated') },
    series: { net: buckets.map((b) => b.net), cost: buckets.map((b) => b.cost), margin: buckets.map((b) => b.margin) },
    products: await cellsBy(c, 'product', currencies),
    panels: await cellsBy(c, 'panel', currencies),
    users: namedUsers,
    resellers: reseller
      ? marginCellsOf(reseller.paid, reseller.served, how).map((cell) => ({ ...cell, name: reseller.nameOf.get(cell.id ?? '') ?? cell.id ?? '' }))
      : null,
    noCostPanels: c.platform ? await noCostPanels(c.tx, c.window) : null,
  };
}
