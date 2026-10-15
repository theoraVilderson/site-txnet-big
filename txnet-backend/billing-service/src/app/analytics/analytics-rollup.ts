import { Prisma, WalletReasonType } from '@prisma/client';

import { ADMIN_FROZEN } from '../entitlement/suspension';
import { REFUND_REASONS, SALE_REASONS } from '../revenue/reseller-revenue.service';
import { referringTo } from '../revenue/revenue-breakdown';
import type { Day } from './analytics-days';

/**
 * The SQL of the analytics rollup (F-1001-a, billing/contract.analytics.md
 * "Rollup tables"). Every statement is scoped by `public.current_tenant_id()`,
 * the value RLS reads and `tenantTransaction` binds — raw SQL skips the
 * `TENANT_SCOPED_MODELS` filter, so the condition is written against the
 * scope itself, as `revenue-breakdown.ts` does.
 *
 * **A sale is what `/revenue` says it is** (principle 2): the ledger rows read
 * here are exactly `SALE_REASONS` debits and `REFUND_REASONS` credits, so a
 * range's `net` is `/revenue`'s `sales.total` for the same window, per currency.
 */

/** One pass's window: the tenant days `fromDay`..`toDay` and the instants `[from, to)` they cover in `zone`. */
export type RollupRange = { fromDay: Day; toDay: Day; from: Date; to: Date; zone: string };

/** A sale that names an invoice is a catalog product bought up front (`package`); one naming a Grant is paid as used. */
const PACKAGE_REASONS = referringTo('invoice');
const GRANT_REASONS = referringTo('grant');

/** The tenant day an instant column falls on — `createdAt` is UTC without a zone (C-37). */
const dayIn = (column: Prisma.Sql, zone: string) => Prisma.sql`((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${zone})::date`;

/** Sales and the refunds that undo them in the window, each with its owner and tenant day. */
const ledger = (r: RollupRange) => Prisma.sql`
  SELECT wt."amount", wt."currencyCode", wt."referenceId",
         wt."reasonType"::text = ANY(${PACKAGE_REASONS}) AS "package",
         wt."reasonType"::text AS "reason",
         wt."direction" = 'debit' AS "sale",
         ${dayIn(Prisma.sql`wt."createdAt"`, r.zone)} AS "day",
         w."ownerUserId" AS "owner"
  FROM billing.wallet_transaction wt
  JOIN billing.wallet w ON w."id" = wt."walletId"
  WHERE wt."tenantId" = public.current_tenant_id()
    AND wt."createdAt" >= ${r.from} AND wt."createdAt" < ${r.to}
    AND ((wt."direction" = 'debit' AND wt."reasonType"::text = ANY(${SALE_REASONS}))
      OR (wt."direction" = 'credit' AND wt."reasonType"::text = ANY(${REFUND_REASONS})))`;

/** Serialises passes over one tenant: two overlapping ticks would otherwise both insert the same grain. */
export async function lockTenantRollup(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('analytics_rollup:' || public.current_tenant_id()::text))`;
}

/**
 * A digest of the tenant's rows in the window — taken before and after a pass,
 * so `billing.analytics.refreshed` is written only when a row actually changed.
 */
export async function rollupFingerprint(tx: Prisma.TransactionClient, r: RollupRange): Promise<string> {
  const [row] = await tx.$queryRaw<{ digest: string }[]>`
    SELECT md5(COALESCE(string_agg(x, '|' ORDER BY x), '')) AS "digest" FROM (
      SELECT 's' || row(s."day", s."currencyCode", s."productId", s."variantId", s."panelId", s."kind", s."gross", s."refunds", s."net", s."orders", s."bytesSold", s."discounts")::text AS x
        FROM billing.analytics_sales_day s WHERE s."tenantId" = public.current_tenant_id() AND s."day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
      UNION ALL
      SELECT 'u' || row(u."day", u."currencyCode", u."userId", u."net", u."orders", u."topUps", u."firstPurchase")::text
        FROM billing.analytics_user_day u WHERE u."tenantId" = public.current_tenant_id() AND u."day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
      UNION ALL
      SELECT 'p' || row(p."day", p."currencyCode", p."gatewayKind", p."started", p."settled", p."failed", p."settledAmount", p."giftsCredited")::text
        FROM billing.analytics_payment_day p WHERE p."tenantId" = public.current_tenant_id() AND p."day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
      UNION ALL
      SELECT 'k' || row(k."day", k."productId", k."panelId", k."activeGrants", k."frozenGrants", k."activeUsers", k."bytesUsed")::text
        FROM billing.analytics_stock_day k WHERE k."tenantId" = public.current_tenant_id() AND k."day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
    ) q`;
  return row?.digest ?? '';
}

/** The three flow tables' rows in the window, gone — the pass writes them again whole. */
export async function clearFlows(tx: Prisma.TransactionClient, r: RollupRange): Promise<void> {
  for (const table of [Prisma.sql`billing.analytics_sales_day`, Prisma.sql`billing.analytics_user_day`, Prisma.sql`billing.analytics_payment_day`]) {
    await tx.$executeRaw`DELETE FROM ${table} WHERE "tenantId" = public.current_tenant_id() AND "day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date`;
  }
}

/**
 * `analytics_sales_day`: per day, currency, product, variant, panel and kind.
 * A purchase is tied to its product through its invoice, a block or a meter's
 * charge through its Grant (`REFERS_TO`); the panel is the Grant's first
 * config's. `bytesSold` is a package's traffic bag (`quotas.traffic_bytes`) —
 * a block's bytes are not on its ledger row, so usage sells 0 bytes here and
 * its traffic is `bytesUsed`.
 */
export async function writeSales(tx: Prisma.TransactionClient, r: RollupRange): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO billing.analytics_sales_day ("tenantId", "day", "currencyCode", "productId", "variantId", "panelId", "kind", "gross", "refunds", "net", "orders", "bytesSold", "discounts")
    WITH led AS (${ledger(r)}),
    tied AS (
      SELECT led.*,
             COALESCE(i."variantId", g."variantId") AS "variantId",
             COALESCE(gi."id", g."id") AS "grantId",
             CASE WHEN jsonb_typeof(gi."quotas"->'traffic_bytes'->'limit') = 'number'
                  THEN (gi."quotas"->'traffic_bytes'->>'limit')::numeric::bigint ELSE 0 END AS "bytes",
             COALESCE(i."discount" + i."ruleDiscount", 0) AS "discount"
      FROM led
      LEFT JOIN billing.invoice i ON i."id" = led."referenceId" AND led."package"
      LEFT JOIN entitlement."grant" g ON g."id" = led."referenceId" AND led."reason" = ANY(${GRANT_REASONS})
      LEFT JOIN LATERAL (
        SELECT x."id", x."quotas" FROM entitlement."grant" x WHERE x."sourceReferenceId" = i."id" ORDER BY x."createdAt" LIMIT 1
      ) gi ON i."id" IS NOT NULL
    )
    SELECT public.current_tenant_id(), t."day", t."currencyCode", v."productId", t."variantId", pn."panelId",
           (CASE WHEN t."package" THEN 'package' ELSE 'usage' END)::billing."AnalyticsSaleKind",
           COALESCE(SUM(t."amount") FILTER (WHERE t."sale"), 0),
           COALESCE(SUM(t."amount") FILTER (WHERE NOT t."sale"), 0),
           SUM(CASE WHEN t."sale" THEN t."amount" ELSE -t."amount" END),
           (COUNT(*) FILTER (WHERE t."package" AND t."sale") - COUNT(*) FILTER (WHERE t."package" AND NOT t."sale"))::int,
           SUM(CASE WHEN NOT t."package" THEN 0 WHEN t."sale" THEN t."bytes" ELSE -t."bytes" END)::bigint,
           COALESCE(SUM(t."discount") FILTER (WHERE t."sale"), 0)
    FROM tied t
    LEFT JOIN catalog.product_variant v ON v."id" = t."variantId"
    LEFT JOIN LATERAL (
      SELECT c."panelId" FROM network.config c WHERE c."grantId" = t."grantId" ORDER BY c."createdAt" LIMIT 1
    ) pn ON t."grantId" IS NOT NULL
    GROUP BY t."day", t."currencyCode", v."productId", t."variantId", pn."panelId", t."package"`;
}

/**
 * `analytics_user_day`: each user's net sales, orders and settled top-ups per
 * day and currency — only users with any. `firstPurchase` marks the day and
 * currency of the user's first sale ever in this tenant, read over all time.
 * Top-ups are `/revenue`'s: settled, and never a reseller's own payment to the
 * platform (`billingTenantId` set).
 */
export async function writeUsers(tx: Prisma.TransactionClient, r: RollupRange): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO billing.analytics_user_day ("tenantId", "day", "currencyCode", "userId", "net", "orders", "topUps", "firstPurchase")
    WITH led AS (${ledger(r)}),
    sold AS (
      SELECT led."day", led."currencyCode", led."owner" AS "userId",
             SUM(CASE WHEN led."sale" THEN led."amount" ELSE -led."amount" END) AS "net",
             (COUNT(*) FILTER (WHERE led."package" AND led."sale") - COUNT(*) FILTER (WHERE led."package" AND NOT led."sale"))::int AS "orders",
             0::numeric AS "topUps"
      FROM led GROUP BY 1, 2, 3
    ),
    paid AS (
      SELECT ${dayIn(Prisma.sql`p."createdAt"`, r.zone)} AS "day", p."currencyCode", p."userId",
             0::numeric AS "net", 0 AS "orders", SUM(p."amountCredited") AS "topUps"
      FROM billing.payment_transaction p
      WHERE p."tenantId" = public.current_tenant_id() AND p."status" = 'success' AND p."billingTenantId" IS NULL
        AND p."createdAt" >= ${r.from} AND p."createdAt" < ${r.to}
      GROUP BY 1, 2, 3
    ),
    firsts AS (
      SELECT DISTINCT ON (w."ownerUserId") w."ownerUserId" AS "userId", ${dayIn(Prisma.sql`wt."createdAt"`, r.zone)} AS "day", wt."currencyCode"
      FROM billing.wallet_transaction wt
      JOIN billing.wallet w ON w."id" = wt."walletId"
      WHERE wt."tenantId" = public.current_tenant_id() AND wt."direction" = 'debit' AND wt."reasonType"::text = ANY(${SALE_REASONS})
        AND w."ownerUserId" IN (SELECT "userId" FROM sold)
      ORDER BY w."ownerUserId", wt."createdAt", wt."id"
    )
    SELECT public.current_tenant_id(), a."day", a."currencyCode", a."userId", SUM(a."net"), SUM(a."orders")::int, SUM(a."topUps"),
           EXISTS (SELECT 1 FROM firsts f WHERE f."userId" = a."userId" AND f."day" = a."day" AND f."currencyCode" = a."currencyCode")
    FROM (SELECT * FROM sold UNION ALL SELECT * FROM paid) a
    GROUP BY a."day", a."currencyCode", a."userId"`;
}

/**
 * `analytics_payment_day`: top-up attempts by the day they started and their
 * gateway's provider — started, settled, failed (an expired attempt is
 * neither) — and, under a null kind, coupon and gift credits.
 */
export async function writePayments(tx: Prisma.TransactionClient, r: RollupRange): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO billing.analytics_payment_day ("tenantId", "day", "currencyCode", "gatewayKind", "started", "settled", "failed", "settledAmount", "giftsCredited")
    WITH att AS (
      SELECT ${dayIn(Prisma.sql`p."createdAt"`, r.zone)} AS "day", p."currencyCode",
             COALESCE(pg."providerName", tg."providerName") AS "kind",
             1 AS "started", (p."status" = 'success')::int AS "settled", (p."status" = 'failed')::int AS "failed",
             CASE WHEN p."status" = 'success' THEN p."amountCredited" ELSE 0 END AS "amount", 0::numeric AS "gift"
      FROM billing.payment_transaction p
      LEFT JOIN billing.payment_gateway pg ON pg."id" = p."gatewayId"
      LEFT JOIN tenant.tenant_gateway_config tg ON tg."id" = p."tenantGatewayConfigId"
      WHERE p."tenantId" = public.current_tenant_id() AND p."billingTenantId" IS NULL
        AND p."createdAt" >= ${r.from} AND p."createdAt" < ${r.to}
      UNION ALL
      SELECT ${dayIn(Prisma.sql`wt."createdAt"`, r.zone)}, wt."currencyCode", NULL, 0, 0, 0, 0, wt."amount"
      FROM billing.wallet_transaction wt
      WHERE wt."tenantId" = public.current_tenant_id() AND wt."direction" = 'credit'
        AND wt."reasonType"::text = ${WalletReasonType.coupon_redemption}
        AND wt."createdAt" >= ${r.from} AND wt."createdAt" < ${r.to}
    )
    SELECT public.current_tenant_id(), a."day", a."currencyCode", a."kind",
           SUM(a."started")::int, SUM(a."settled")::int, SUM(a."failed")::int, SUM(a."amount"), SUM(a."gift")
    FROM att a GROUP BY a."day", a."currencyCode", a."kind"`;
}

/**
 * `analytics_stock_day` for `today`: the Grants standing now, per product and
 * the panel of each one's first config. A stock is a snapshot — no ledger
 * holds a Grant's past freezes — so only today is written; each day keeps the
 * last snapshot taken while it was today, which is its end of day.
 */
export async function writeStockToday(tx: Prisma.TransactionClient, today: Day): Promise<void> {
  await tx.$executeRaw`DELETE FROM billing.analytics_stock_day WHERE "tenantId" = public.current_tenant_id() AND "day" = ${today}::date`;
  await tx.$executeRaw`
    INSERT INTO billing.analytics_stock_day ("tenantId", "day", "productId", "panelId", "activeGrants", "frozenGrants", "activeUsers", "bytesUsed")
    SELECT public.current_tenant_id(), ${today}::date, v."productId", pn."panelId",
           (COUNT(*) FILTER (WHERE g."status" = 'active'))::int,
           (COUNT(*) FILTER (WHERE g."status" = 'suspended'))::int,
           (COUNT(DISTINCT g."userId") FILTER (WHERE g."status" = 'active'))::int,
           0
    FROM entitlement."grant" g
    LEFT JOIN catalog.product_variant v ON v."id" = g."variantId"
    LEFT JOIN LATERAL (
      SELECT c."panelId" FROM network.config c WHERE c."grantId" = g."id" ORDER BY c."createdAt" LIMIT 1
    ) pn ON true
    WHERE g."tenantId" = public.current_tenant_id()
      AND (g."status" = 'active' OR (g."status" = 'suspended' AND g."statusReason" = ${ADMIN_FROZEN}))
    GROUP BY v."productId", pn."panelId"`;
}

/**
 * `bytesUsed` on every day of the window from the network's daily aggregate,
 * per product and the config's own panel. That aggregate is cut on UTC dates
 * and written nightly, so a day's traffic lands on the pass after it.
 */
export async function writeTraffic(tx: Prisma.TransactionClient, r: RollupRange): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO billing.analytics_stock_day ("tenantId", "day", "productId", "panelId", "activeGrants", "frozenGrants", "activeUsers", "bytesUsed")
    SELECT public.current_tenant_id(), t."date", v."productId", c."panelId", 0, 0, 0, SUM(t."totalUploadBytes" + t."totalDownloadBytes")::bigint
    FROM network.traffic_daily_aggregate t
    JOIN network.config c ON c."id" = t."configId" AND c."tenantId" = public.current_tenant_id()
    JOIN entitlement."grant" g ON g."id" = c."grantId"
    LEFT JOIN catalog.product_variant v ON v."id" = g."variantId"
    WHERE t."date" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
    GROUP BY t."date", v."productId", c."panelId"
    ON CONFLICT ("tenantId", "day", "productId", "panelId") DO UPDATE SET "bytesUsed" = EXCLUDED."bytesUsed"`;
}

/** The tenant's first day with anything to roll up — where a whole rebuild starts. */
export async function firstActivity(tx: Prisma.TransactionClient): Promise<Date | null> {
  const [row] = await tx.$queryRaw<{ at: Date | null }[]>`
    SELECT LEAST(
      (SELECT MIN(wt."createdAt") FROM billing.wallet_transaction wt WHERE wt."tenantId" = public.current_tenant_id()),
      (SELECT MIN(p."createdAt") FROM billing.payment_transaction p WHERE p."tenantId" = public.current_tenant_id())
    ) AS "at"`;
  return row?.at ?? null;
}
