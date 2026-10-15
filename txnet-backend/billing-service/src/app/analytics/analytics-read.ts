import { Prisma } from '@prisma/client';

import type { Day } from './analytics-days';

/**
 * The SQL every analytics tab reads (F-1001-b) — the rollup tables only, never
 * a ledger (billing/contract.analytics.md principle 1). Scoped by
 * `public.current_tenant_id()`, as the rollup is written.
 *
 * A series is cut by a **day map**: the window's days paired with the key of
 * the bucket (or sparkline point) each falls in, built in TypeScript where the
 * Jalali calendar lives and joined here — so a distinct count (buyers) is
 * counted per bucket, never summed from days.
 */

/** The filters a tab takes; `kind` narrows sales only — payments have no product. */
export type AnalyticsFilters = { product?: string; panel?: string; kind?: 'package' | 'usage' };

/** A window of tenant days, both included. */
export type Window = { from: Day; to: Day };

/** Each day of the window and the bucket it falls in. */
export type DayMap = { days: Day[]; keys: Day[] };

/** What a sales or buyer row may be split by, besides its currency. */
export type SalesSplit = 'bucket' | 'kind' | 'product' | 'panel';

export type SalesRow = {
  bucket: string | null;
  kind: 'package' | 'usage' | null;
  productId: string | null;
  panelId: string | null;
  currencyCode: string;
  gross: Prisma.Decimal;
  refunds: Prisma.Decimal;
  net: Prisma.Decimal;
  orders: number;
  bytesSold: bigint;
  discounts: Prisma.Decimal;
};

export type BuyerRow = { bucket: string | null; productId: string | null; panelId: string | null; buyers: number; newBuyers: number };

export type PaymentRow = {
  bucket: string | null;
  gatewayKind: string | null;
  currencyCode: string;
  started: number;
  settled: number;
  failed: number;
  settledAmount: Prisma.Decimal;
  giftsCredited: Prisma.Decimal;
};

const in_ = (alias: Prisma.Sql, w: Window) =>
  Prisma.sql`${alias}."tenantId" = public.current_tenant_id() AND ${alias}."day" BETWEEN ${w.from}::date AND ${w.to}::date`;

/** The bucket join, or nothing: a closed fragment, never caller text. */
const bucketJoin = (alias: Prisma.Sql, map?: DayMap) =>
  map ? Prisma.sql`JOIN unnest(${map.days}::date[], ${map.keys}::date[]) AS m("day", "bucket") ON m."day" = ${alias}."day"` : Prisma.empty;

/** One select-and-group column per split; an unasked split reads null so every row has the same shape. */
function splitColumns(alias: Prisma.Sql, splits: readonly SalesSplit[]) {
  const columns: Record<SalesSplit, { value: Prisma.Sql; select: Prisma.Sql; none: Prisma.Sql }> = {
    bucket: { value: Prisma.sql`m."bucket"`, select: Prisma.sql`to_char(m."bucket", 'YYYY-MM-DD') AS "bucket"`, none: Prisma.sql`NULL AS "bucket"` },
    kind: { value: Prisma.sql`${alias}."kind"`, select: Prisma.sql`${alias}."kind"::text AS "kind"`, none: Prisma.sql`NULL AS "kind"` },
    product: { value: Prisma.sql`${alias}."productId"`, select: Prisma.sql`${alias}."productId" AS "productId"`, none: Prisma.sql`NULL AS "productId"` },
    panel: { value: Prisma.sql`${alias}."panelId"`, select: Prisma.sql`${alias}."panelId" AS "panelId"`, none: Prisma.sql`NULL AS "panelId"` },
  };
  const order: SalesSplit[] = ['bucket', 'kind', 'product', 'panel'];
  return {
    select: Prisma.join(order.map((split) => (splits.includes(split) ? columns[split].select : columns[split].none))),
    group: order.filter((split) => splits.includes(split)).map((split) => columns[split].value),
  };
}

const productPanel = (alias: Prisma.Sql, f: AnalyticsFilters) => Prisma.sql`
  ${f.product ? Prisma.sql`AND ${alias}."productId" = ${f.product}::uuid` : Prisma.empty}
  ${f.panel ? Prisma.sql`AND ${alias}."panelId" = ${f.panel}::uuid` : Prisma.empty}`;

/** Sales summed per currency and the splits asked for. */
export function readSales(tx: Prisma.TransactionClient, w: Window, f: AnalyticsFilters, splits: readonly SalesSplit[], map?: DayMap): Promise<SalesRow[]> {
  const s = Prisma.sql`s`;
  const cols = splitColumns(s, splits);
  return tx.$queryRaw<SalesRow[]>`
    SELECT ${cols.select}, s."currencyCode",
           SUM(s."gross") AS "gross", SUM(s."refunds") AS "refunds", SUM(s."net") AS "net",
           SUM(s."orders")::int AS "orders", SUM(s."bytesSold")::bigint AS "bytesSold", SUM(s."discounts") AS "discounts"
    FROM billing.analytics_sales_day s ${bucketJoin(s, map)}
    WHERE ${in_(s, w)} ${productPanel(s, f)}
      ${f.kind ? Prisma.sql`AND s."kind" = ${f.kind}::billing."AnalyticsSaleKind"` : Prisma.empty}
    GROUP BY ${Prisma.join([...cols.group, Prisma.sql`s."currencyCode"`])}`;
}

/**
 * Distinct buyers — a user with a sale or a refund in the cell — and new ones
 * (their first purchase ever fell in the window), per split. Across currencies:
 * a person is one buyer whatever they paid in. `kind` cannot narrow a person.
 */
export function readBuyers(tx: Prisma.TransactionClient, w: Window, f: AnalyticsFilters, splits: readonly Exclude<SalesSplit, 'kind'>[], map?: DayMap): Promise<BuyerRow[]> {
  const u = Prisma.sql`u`;
  const cols = splitColumns(u, splits);
  return tx.$queryRaw<BuyerRow[]>`
    SELECT ${cols.select},
           COUNT(DISTINCT u."userId")::int AS "buyers",
           COUNT(DISTINCT u."userId") FILTER (WHERE u."firstPurchase")::int AS "newBuyers"
    FROM billing.analytics_user_day u ${bucketJoin(u, map)}
    WHERE ${in_(u, w)} ${productPanel(u, f)} AND (u."net" <> 0 OR u."orders" <> 0)
    ${cols.group.length ? Prisma.sql`GROUP BY ${Prisma.join(cols.group)}` : Prisma.empty}`;
}

/** Top-up attempts and gift credits per currency, by bucket and gateway kind when asked. Unfiltered: a payment names no product. */
export function readPayments(tx: Prisma.TransactionClient, w: Window, splits: readonly ('bucket' | 'gatewayKind')[], map?: DayMap): Promise<PaymentRow[]> {
  const p = Prisma.sql`p`;
  const bucket = splits.includes('bucket');
  const kind = splits.includes('gatewayKind');
  const groups = [
    ...(bucket ? [Prisma.sql`m."bucket"`] : []),
    ...(kind ? [Prisma.sql`p."gatewayKind"`] : []),
    Prisma.sql`p."currencyCode"`,
  ];
  return tx.$queryRaw<PaymentRow[]>`
    SELECT ${bucket ? Prisma.sql`to_char(m."bucket", 'YYYY-MM-DD')` : Prisma.sql`NULL`} AS "bucket",
           ${kind ? Prisma.sql`p."gatewayKind"::text` : Prisma.sql`NULL`} AS "gatewayKind",
           p."currencyCode",
           SUM(p."started")::int AS "started", SUM(p."settled")::int AS "settled", SUM(p."failed")::int AS "failed",
           SUM(p."settledAmount") AS "settledAmount", SUM(p."giftsCredited") AS "giftsCredited"
    FROM billing.analytics_payment_day p ${bucketJoin(p, map)}
    WHERE ${in_(p, w)}
    GROUP BY ${Prisma.join(groups)}`;
}

/**
 * Services standing at the end of the window — the last snapshot on or before
 * `to` — and traffic used over it, per product and panel when asked.
 */
export async function readStock(
  tx: Prisma.TransactionClient,
  w: Window,
  f: AnalyticsFilters,
  splits: readonly ('product' | 'panel')[],
): Promise<{ productId: string | null; panelId: string | null; activeGrants: number; bytesUsed: bigint }[]> {
  const k = Prisma.sql`k`;
  const cols = splitColumns(k, splits);
  return tx.$queryRaw`
    WITH last AS (
      SELECT MAX(k."day") AS "day" FROM billing.analytics_stock_day k
      WHERE ${in_(k, w)} AND (k."activeGrants" > 0 OR k."frozenGrants" > 0)
    )
    SELECT ${cols.select},
           (SUM(k."activeGrants") FILTER (WHERE k."day" = (SELECT "day" FROM last)))::int AS "activeGrants",
           SUM(k."bytesUsed")::bigint AS "bytesUsed"
    FROM billing.analytics_stock_day k
    WHERE ${in_(k, w)} ${productPanel(k, f)}
    ${cols.group.length ? Prisma.sql`GROUP BY ${Prisma.join(cols.group)}` : Prisma.empty}`;
}
