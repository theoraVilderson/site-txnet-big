import { Prisma, WalletReasonType } from '@prisma/client';

import type { CurrencyTotal } from './reseller-revenue.service';

/**
 * ADR-0104 (3): a breakdown cell under this many people is shown to the
 * platform as "fewer than 5" — no count, no money. Totals for the whole
 * reseller are not suppressed.
 */
export const SMALL_GROUP = 5;

/** What a suppressed cell says instead of its figures. */
export const FEWER_THAN = 'fewer_than_5' as const;

/**
 * What a sale's or a refund's `referenceId` names, so the row can be tied to
 * the product it sold — exhaustive, so a new reason is judged before it
 * compiles. A purchase names its invoice (`invoice-payment.service.ts`,
 * `delivery.ts`); a block, a meter's charge and their refunds name the Grant
 * (`block-purchase.ts`, `remainder-credit.ts`, `usage-door.ts`, `postpaid-hold.ts`).
 * `null`: no product, or not a sale at all.
 */
const REFERS_TO: Record<WalletReasonType, 'invoice' | 'grant' | null> = {
  [WalletReasonType.product_purchase]: 'invoice',
  [WalletReasonType.product_refund]: 'invoice',
  [WalletReasonType.traffic_consumption]: 'grant',
  [WalletReasonType.traffic_refund]: 'grant',
  [WalletReasonType.usage_charge]: 'grant',
  [WalletReasonType.usage_refund]: 'grant',
  [WalletReasonType.payment_gateway]: null,
  [WalletReasonType.coupon_redemption]: null,
  [WalletReasonType.affiliate_commission]: null,
  [WalletReasonType.wallet_transfer_in]: null,
  [WalletReasonType.sub_account_charge]: null,
  [WalletReasonType.wallet_transfer_out]: null,
  [WalletReasonType.admin_manual_adjust]: null,
  [WalletReasonType.reseller_purchase]: null,
  [WalletReasonType.currency_change]: null,
};

const referringTo = (to: 'invoice' | 'grant') => (Object.keys(REFERS_TO) as WalletReasonType[]).filter((r) => REFERS_TO[r] === to);

/**
 * One row of the aggregate: a cell's people (`perCurrency: false`) or one of
 * its currencies' money (`perCurrency: true`). `dim` says which split it
 * belongs to; `all` is the whole reseller.
 */
export type BreakdownRow = {
  dim: 'product' | 'day' | 'all';
  perCurrency: boolean;
  productId: string | null;
  day: string | null;
  currencyCode: string | null;
  net: Prisma.Decimal | null;
  count: number;
  people: number;
};

/** A cell as answered: its figures, or `fewer_than_5` and none of them. */
export type BreakdownCell = {
  people: number | typeof FEWER_THAN;
  count: number | null;
  total: string | null;
  byCurrency: CurrencyTotal[];
};

export type RevenueBreakdown = {
  from: string;
  to: string;
  currencyCode: string;
  /** The reseller's zone: what a `day` is a day of. */
  timeZone: string;
  /** Whether small cells were suppressed for this reader — the platform's staff. */
  suppressed: boolean;
  /** The whole reseller, never suppressed (ADR-0104 (3)). */
  people: number;
  count: number;
  byProduct: (BreakdownCell & { productId: string | null })[];
  trend: (BreakdownCell & { day: string })[];
};

/** The reseller's sums per currency into its currency now (`ResellerRevenueService.converter`). */
export type Converter = {
  currencyCode: string;
  show: (v: Prisma.Decimal | null) => string | null;
  sum: (sums: Map<string, Prisma.Decimal>) => Promise<Prisma.Decimal | null>;
};

/**
 * Sales net of their refunds, split by product and by day, with the number of
 * distinct people in each cell — one query, so every cell is counted from the
 * same rows. People are wallet owners (`wallet.ownerUserId` is unique); a
 * refund's owner counts too, so a cell is never smaller than who it touched.
 *
 * **The scope is `public.current_tenant_id()`**, the value RLS reads and
 * `tenantTransaction` binds — never a tenant id passed in. Raw SQL skips the
 * `TENANT_SCOPED_MODELS` filter, so the condition is written against the
 * scope itself, beside the policy.
 */
export function readBreakdown(tx: Prisma.TransactionClient, period: { from: Date; to: Date }, zone: string, sales: WalletReasonType[], refunds: WalletReasonType[]) {
  return tx.$queryRaw<BreakdownRow[]>`
    WITH s AS (
      SELECT COALESCE(iv."productId", gv."productId") AS "productId",
             to_char(("wt"."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${zone}, 'YYYY-MM-DD') AS "day",
             "wt"."currencyCode",
             CASE WHEN "wt"."direction" = 'debit' THEN "wt"."amount" ELSE -"wt"."amount" END AS "net",
             "wt"."direction" = 'debit' AS "sale",
             w."ownerUserId" AS "owner"
      FROM billing.wallet_transaction "wt"
      JOIN billing.wallet w ON w."id" = "wt"."walletId"
      LEFT JOIN billing.invoice i ON i."id" = "wt"."referenceId" AND "wt"."reasonType"::text = ANY(${referringTo('invoice')})
      LEFT JOIN catalog.product_variant iv ON iv."id" = i."variantId"
      LEFT JOIN entitlement."grant" g ON g."id" = "wt"."referenceId" AND "wt"."reasonType"::text = ANY(${referringTo('grant')})
      LEFT JOIN catalog.product_variant gv ON gv."id" = g."variantId"
      WHERE "wt"."tenantId" = public.current_tenant_id()
        AND "wt"."createdAt" >= ${period.from} AND "wt"."createdAt" <= ${period.to}
        AND (("wt"."direction" = 'debit' AND "wt"."reasonType"::text = ANY(${sales}))
          OR ("wt"."direction" = 'credit' AND "wt"."reasonType"::text = ANY(${refunds})))
    )
    SELECT CASE WHEN GROUPING("productId") = 0 THEN 'product' WHEN GROUPING("day") = 0 THEN 'day' ELSE 'all' END AS "dim",
           GROUPING("currencyCode") = 0 AS "perCurrency",
           "productId", "day", "currencyCode",
           SUM("net") AS "net",
           (COUNT(*) FILTER (WHERE "sale"))::int AS "count",
           COUNT(DISTINCT "owner")::int AS "people"
    FROM s
    GROUP BY GROUPING SETS (("productId", "currencyCode"), ("productId"), ("day", "currencyCode"), ("day"), ())`;
}

/**
 * Which cells of one split the platform does not see: every cell under
 * {@link SMALL_GROUP} people, and — when that is exactly one — the smallest
 * shown cell with it (F-117-i). The whole reseller's figures are answered
 * (`/revenue`, and `people`/`count` here), so one hidden cell is the total minus
 * the shown ones; two hidden cells give only their sum, which names no single
 * small group. Smallest by people, then count, then position, so the choice is
 * fixed for the same rows.
 */
export function hiddenCells(heads: readonly BreakdownRow[]): Set<BreakdownRow> {
  const hidden = new Set(heads.filter((h) => h.people < SMALL_GROUP));
  if (hidden.size !== 1) return hidden;
  const next = heads
    .filter((h) => !hidden.has(h))
    .reduce<BreakdownRow | null>((min, h) => (!min || h.people < min.people || (h.people === min.people && h.count < min.count) ? h : min), null);
  if (next) hidden.add(next);
  return hidden;
}

const ZERO = new Prisma.Decimal(0);
const money = (v: Prisma.Decimal | null) => (v ?? ZERO).toFixed(2);

/**
 * The rows as cells. For the platform's staff (`staff`) a cell under
 * {@link SMALL_GROUP} people, and its complement ({@link hiddenCells}), keeps
 * only `fewer_than_5`, and the suppressed
 * cells come after the shown ones in a fixed order, so where one sits says
 * nothing about its size either. The whole reseller is never suppressed.
 */
export async function breakdownOf(
  rows: readonly BreakdownRow[],
  ctx: { staff: boolean; convert: Converter; period: { from: Date; to: Date }; timeZone: string },
): Promise<RevenueBreakdown> {
  const all = rows.find((r) => r.dim === 'all' && !r.perCurrency);

  const cells = async (dim: 'product' | 'day', keyOf: (r: BreakdownRow) => string | null) => {
    const heads = rows.filter((r) => r.dim === dim && !r.perCurrency);
    const hidden = ctx.staff ? hiddenCells(heads) : new Set<BreakdownRow>();
    const out: { key: string | null; cell: BreakdownCell }[] = [];
    for (const head of heads) {
      const key = keyOf(head);
      if (hidden.has(head)) {
        out.push({ key, cell: { people: FEWER_THAN, count: null, total: null, byCurrency: [] } });
        continue;
      }
      const parts = rows
        .filter((r) => r.dim === dim && r.perCurrency && keyOf(r) === key && r.currencyCode)
        .sort((a, b) => (a.currencyCode as string).localeCompare(b.currencyCode as string));
      const sums = new Map(parts.map((p) => [p.currencyCode as string, new Prisma.Decimal(money(p.net))]));
      out.push({
        key,
        cell: {
          people: head.people,
          count: head.count,
          total: ctx.convert.show(await ctx.convert.sum(sums)),
          byCurrency: parts.map((p) => ({ currencyCode: p.currencyCode as string, total: money(p.net), count: p.count })),
        },
      });
    }
    return out;
  };

  const shownFirst = (a: BreakdownCell, b: BreakdownCell) => Number(a.people === FEWER_THAN) - Number(b.people === FEWER_THAN);
  const byKey = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b));

  const products = (await cells('product', (r) => r.productId)).sort(
    (a, b) => shownFirst(a.cell, b.cell) || (b.cell.count ?? 0) - (a.cell.count ?? 0) || byKey(a.key, b.key),
  );
  const days = (await cells('day', (r) => r.day)).sort((a, b) => byKey(a.key, b.key));

  return {
    from: ctx.period.from.toISOString(),
    to: ctx.period.to.toISOString(),
    currencyCode: ctx.convert.currencyCode,
    timeZone: ctx.timeZone,
    suppressed: ctx.staff,
    people: all?.people ?? 0,
    count: all?.count ?? 0,
    byProduct: products.map(({ key, cell }) => ({ productId: key, ...cell })),
    trend: days.map(({ key, cell }) => ({ day: key as string, ...cell })),
  };
}
