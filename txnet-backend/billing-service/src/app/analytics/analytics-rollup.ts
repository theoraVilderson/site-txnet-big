import { Prisma, WalletReasonType } from '@prisma/client';
import { METER_KEYS } from '@txnet-backend/shared-core';

import { ADMIN_FROZEN } from '../entitlement/suspension';
import { REFUND_REASONS, SALE_REASONS } from '../revenue/reseller-revenue.service';
import { referringTo } from '../revenue/revenue-breakdown';
import type { Day } from './analytics-days';
import { FxTable, fxAmount, fxCurrency, fxJoin } from './analytics-fx';

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
export const dayIn = (column: Prisma.Sql, zone: string) => Prisma.sql`((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${zone})::date`;

/**
 * Sales and the refunds that undo them in the window, each with its owner and
 * tenant day, in the money that moved (`rawAmount` in `rawCurrency`).
 */
const ledger = (r: RollupRange) => Prisma.sql`
  SELECT wt."amount" AS "rawAmount", wt."currencyCode" AS "rawCurrency", wt."referenceId",
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

/** Every currency the window's money moved in — sales, refunds, gifts, top-ups — what `fx` must cover (ADR-0152). */
export async function currenciesIn(tx: Prisma.TransactionClient, r: RollupRange): Promise<string[]> {
  const rows = await tx.$queryRaw<{ code: string }[]>`
    SELECT DISTINCT wt."currencyCode" AS "code" FROM billing.wallet_transaction wt
    WHERE wt."tenantId" = public.current_tenant_id() AND wt."createdAt" >= ${r.from} AND wt."createdAt" < ${r.to}
    UNION
    SELECT DISTINCT p."currencyCode" FROM billing.payment_transaction p
    WHERE p."tenantId" = public.current_tenant_id() AND p."createdAt" >= ${r.from} AND p."createdAt" < ${r.to}`;
  return rows.map((row) => row.code);
}

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
      SELECT 'u' || row(u."day", u."currencyCode", u."userId", u."productId", u."panelId", u."net", u."orders", u."topUps", u."firstPurchase")::text
        FROM billing.analytics_user_day u WHERE u."tenantId" = public.current_tenant_id() AND u."day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
      UNION ALL
      SELECT 'p' || row(p."day", p."currencyCode", p."gatewayKind", p."started", p."settled", p."failed", p."settledAmount", p."giftsCredited")::text
        FROM billing.analytics_payment_day p WHERE p."tenantId" = public.current_tenant_id() AND p."day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
      UNION ALL
      SELECT 'k' || row(k."day", k."productId", k."panelId", k."activeGrants", k."frozenGrants", k."activeUsers", k."bytesUsed")::text
        FROM billing.analytics_stock_day k WHERE k."tenantId" = public.current_tenant_id() AND k."day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
      UNION ALL
      SELECT 'm' || row(e."day", e."productId", e."panelId", e."meterKey", e."quantity", e."grants")::text
        FROM billing.analytics_meter_day e WHERE e."tenantId" = public.current_tenant_id() AND e."day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
      UNION ALL
      SELECT 'c' || row(c."day", c."kind", c."panelId", c."servedTenantId", c."productId", c."userId", c."currencyCode", c."cost", c."bytes")::text
        FROM billing.analytics_cost_day c WHERE c."tenantId" = public.current_tenant_id() AND c."day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
    ) q`;
  return row?.digest ?? '';
}

/** The flow tables' rows in the window, gone — the pass writes them again whole. */
export async function clearFlows(tx: Prisma.TransactionClient, r: RollupRange): Promise<void> {
  const flows = [Prisma.sql`billing.analytics_sales_day`, Prisma.sql`billing.analytics_user_day`, Prisma.sql`billing.analytics_payment_day`, Prisma.sql`billing.analytics_meter_day`];
  for (const table of flows) {
    await tx.$executeRaw`DELETE FROM ${table} WHERE "tenantId" = public.current_tenant_id() AND "day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date`;
  }
}

/**
 * Each sale and refund of the window tied to what was sold: a purchase through
 * its invoice, a block or a meter's charge through its Grant (`REFERS_TO`);
 * the panel is the Grant's first config's. `bytes` is a package's traffic bag
 * (`quotas.traffic_bytes`) — a block's bytes are not on its ledger row.
 * `discount` is the invoice's whole discount: it already holds the rule's
 * share (`ruleDiscount` <= `discount`, `invoice.service.ts`), so adding
 * `ruleDiscount` again would count a rule discount twice. Every amount is in
 * the tenant's currency now at its day's rate (`fx`, ADR-0152), the discount
 * by the same factor as its sale.
 */
const withTied = (r: RollupRange, fx: FxTable) => Prisma.sql`
  WITH led AS (
    SELECT l.*, ${fxAmount(Prisma.sql`l."rawAmount"`, Prisma.sql`f`)} AS "amount", ${fxCurrency(fx, Prisma.sql`l."rawCurrency"`, Prisma.sql`f`)} AS "currencyCode",
           COALESCE(f."factor", 1) AS "factor"
    FROM (${ledger(r)}) l ${fxJoin(fx, Prisma.sql`f`, Prisma.sql`l."rawCurrency"`, Prisma.sql`l."day"`)}
  ),
  tied AS (
    SELECT led.*, v."productId", sold."variantId", pn."panelId",
           CASE WHEN jsonb_typeof(gi."quotas"->'traffic_bytes'->'limit') = 'number'
                THEN (gi."quotas"->'traffic_bytes'->>'limit')::numeric::bigint ELSE 0 END AS "bytes",
           COALESCE(i."discount", 0) * led."factor" AS "discount"
    FROM led
    LEFT JOIN billing.invoice i ON i."id" = led."referenceId" AND led."package"
    LEFT JOIN entitlement."grant" g ON g."id" = led."referenceId" AND led."reason" = ANY(${GRANT_REASONS})
    LEFT JOIN LATERAL (
      SELECT x."id", x."quotas" FROM entitlement."grant" x WHERE x."sourceReferenceId" = i."id" ORDER BY x."createdAt" LIMIT 1
    ) gi ON i."id" IS NOT NULL
    CROSS JOIN LATERAL (SELECT COALESCE(i."variantId", g."variantId") AS "variantId", COALESCE(gi."id", g."id") AS "grantId") sold
    LEFT JOIN catalog.product_variant v ON v."id" = sold."variantId"
    LEFT JOIN LATERAL (
      SELECT c."panelId" FROM network.config c WHERE c."grantId" = sold."grantId" ORDER BY c."createdAt" LIMIT 1
    ) pn ON sold."grantId" IS NOT NULL
  )`;

/**
 * A rollup amount rounded once, half up, to its row currency's places (ADR-0153
 * point 1): a sum converted by a currency change's factor has more digits than
 * the currency has, and the column, `DECIMAL(20,4)`, no longer rounds them away.
 */
const moneyAt = (amount: Prisma.Sql, currencyCode: Prisma.Sql) =>
  Prisma.sql`round(${amount}, (SELECT cu."decimalPlaces" FROM currency.currency cu WHERE cu."code" = ${currencyCode}))`;

/** Package orders net of the package refunds that undo them. */
const NET_ORDERS = Prisma.sql`(COUNT(*) FILTER (WHERE t."package" AND t."sale") - COUNT(*) FILTER (WHERE t."package" AND NOT t."sale"))::int`;

/**
 * `analytics_sales_day`: per day, currency, product, variant, panel and kind.
 * `bytesSold` is net of a refunded package; usage sells 0 bytes here, and its
 * traffic is `bytesUsed`. Gross and refunds are rounded once each, at the sum,
 * and net is their difference — so converted amounts never leave net a cent
 * off gross less refunds.
 */
export async function writeSales(tx: Prisma.TransactionClient, r: RollupRange, fx: FxTable): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO billing.analytics_sales_day ("tenantId", "day", "currencyCode", "productId", "variantId", "panelId", "kind", "gross", "refunds", "net", "orders", "bytesSold", "discounts")
    ${withTied(r, fx)}
    SELECT public.current_tenant_id(), x."day", x."currencyCode", x."productId", x."variantId", x."panelId", x."kind", x."gross", x."refunds", x."gross" - x."refunds", x."orders", x."bytesSold", x."discounts"
    FROM (
      SELECT t."day", t."currencyCode", t."productId", t."variantId", t."panelId",
             (CASE WHEN t."package" THEN 'package' ELSE 'usage' END)::billing."AnalyticsSaleKind" AS "kind",
             ${moneyAt(Prisma.sql`COALESCE(SUM(t."amount") FILTER (WHERE t."sale"), 0)`, Prisma.sql`t."currencyCode"`)} AS "gross",
             ${moneyAt(Prisma.sql`COALESCE(SUM(t."amount") FILTER (WHERE NOT t."sale"), 0)`, Prisma.sql`t."currencyCode"`)} AS "refunds",
             ${NET_ORDERS} AS "orders",
             SUM(CASE WHEN NOT t."package" THEN 0 WHEN t."sale" THEN t."bytes" ELSE -t."bytes" END)::bigint AS "bytesSold",
             ${moneyAt(Prisma.sql`COALESCE(SUM(t."discount") FILTER (WHERE t."sale"), 0)`, Prisma.sql`t."currencyCode"`)} AS "discounts"
      FROM tied t
      GROUP BY t."day", t."currencyCode", t."productId", t."variantId", t."panelId", t."package"
    ) x`;
}

/**
 * `analytics_user_day`: each user's net sales and orders per day, currency,
 * product and panel, and settled top-ups (no product, no panel) — only users
 * with any. `firstPurchase` marks the day and currency of the user's first
 * sale ever in this tenant, read over all time. Top-ups are `/revenue`'s:
 * settled, and never a reseller's own payment to the platform.
 */
export async function writeUsers(tx: Prisma.TransactionClient, r: RollupRange, fx: FxTable): Promise<void> {
  const [f, p, A] = [Prisma.sql`f`, Prisma.sql`p`, Prisma.sql`a."currencyCode"`];
  const paidDay = dayIn(Prisma.sql`p."createdAt"`, r.zone);
  const firstDay = dayIn(Prisma.sql`wt."createdAt"`, r.zone);
  await tx.$executeRaw`
    INSERT INTO billing.analytics_user_day ("tenantId", "day", "currencyCode", "userId", "productId", "panelId", "net", "orders", "topUps", "firstPurchase")
    ${withTied(r, fx)},
    sold AS (
      SELECT t."day", t."currencyCode", t."owner" AS "userId", t."productId", t."panelId",
             SUM(CASE WHEN t."sale" THEN t."amount" ELSE -t."amount" END) AS "net", ${NET_ORDERS} AS "orders", 0::numeric AS "topUps"
      FROM tied t GROUP BY 1, 2, 3, 4, 5
    ),
    paid AS (
      SELECT ${paidDay} AS "day", ${fxCurrency(fx, Prisma.sql`${p}."currencyCode"`, f)} AS "currencyCode", p."userId", NULL::uuid AS "productId", NULL::uuid AS "panelId",
             0::numeric AS "net", 0 AS "orders", SUM(${fxAmount(Prisma.sql`p."amountCredited"`, f)}) AS "topUps"
      FROM billing.payment_transaction p ${fxJoin(fx, f, Prisma.sql`p."currencyCode"`, paidDay)}
      WHERE p."tenantId" = public.current_tenant_id() AND p."status" = 'success' AND p."billingTenantId" IS NULL
        AND p."createdAt" >= ${r.from} AND p."createdAt" < ${r.to}
      GROUP BY 1, 2, 3
    ),
    firsts AS (
      SELECT DISTINCT ON (w."ownerUserId") w."ownerUserId" AS "userId", ${firstDay} AS "day", ${fxCurrency(fx, Prisma.sql`wt."currencyCode"`, f)} AS "currencyCode"
      FROM billing.wallet_transaction wt
      JOIN billing.wallet w ON w."id" = wt."walletId"
      ${fxJoin(fx, f, Prisma.sql`wt."currencyCode"`, firstDay)}
      WHERE wt."tenantId" = public.current_tenant_id() AND wt."direction" = 'debit' AND wt."reasonType"::text = ANY(${SALE_REASONS})
        AND w."ownerUserId" IN (SELECT "userId" FROM sold)
      ORDER BY w."ownerUserId", wt."createdAt", wt."id"
    )
    SELECT public.current_tenant_id(), a."day", a."currencyCode", a."userId", a."productId", a."panelId", ${moneyAt(Prisma.sql`SUM(a."net")`, A)}, SUM(a."orders")::int, ${moneyAt(Prisma.sql`SUM(a."topUps")`, A)},
           EXISTS (SELECT 1 FROM firsts f WHERE f."userId" = a."userId" AND f."day" = a."day" AND f."currencyCode" = a."currencyCode")
    FROM (SELECT * FROM sold UNION ALL SELECT * FROM paid) a
    GROUP BY a."day", a."currencyCode", a."userId", a."productId", a."panelId"`;
}

/**
 * `analytics_payment_day`: top-up attempts by the day they started and their
 * gateway's provider — started, settled, failed (an expired attempt is
 * neither) — and, under a null kind, coupon and gift credits.
 */
export async function writePayments(tx: Prisma.TransactionClient, r: RollupRange, fx: FxTable): Promise<void> {
  const f = Prisma.sql`f`;
  const paidDay = dayIn(Prisma.sql`p."createdAt"`, r.zone);
  const giftDay = dayIn(Prisma.sql`wt."createdAt"`, r.zone);
  await tx.$executeRaw`
    INSERT INTO billing.analytics_payment_day ("tenantId", "day", "currencyCode", "gatewayKind", "started", "settled", "failed", "settledAmount", "giftsCredited")
    WITH att AS (
      SELECT ${paidDay} AS "day", ${fxCurrency(fx, Prisma.sql`p."currencyCode"`, f)} AS "currencyCode",
             COALESCE(pg."providerName", tg."providerName") AS "kind",
             1 AS "started", (p."status" = 'success')::int AS "settled", (p."status" = 'failed')::int AS "failed",
             CASE WHEN p."status" = 'success' THEN ${fxAmount(Prisma.sql`p."amountCredited"`, f)} ELSE 0 END AS "amount", 0::numeric AS "gift"
      FROM billing.payment_transaction p
      LEFT JOIN billing.payment_gateway pg ON pg."id" = p."gatewayId"
      LEFT JOIN tenant.tenant_gateway_config tg ON tg."id" = p."tenantGatewayConfigId"
      ${fxJoin(fx, f, Prisma.sql`p."currencyCode"`, paidDay)}
      WHERE p."tenantId" = public.current_tenant_id() AND p."billingTenantId" IS NULL
        AND p."createdAt" >= ${r.from} AND p."createdAt" < ${r.to}
      UNION ALL
      SELECT ${giftDay}, ${fxCurrency(fx, Prisma.sql`wt."currencyCode"`, f)}, NULL, 0, 0, 0, 0, ${fxAmount(Prisma.sql`wt."amount"`, f)}
      FROM billing.wallet_transaction wt ${fxJoin(fx, f, Prisma.sql`wt."currencyCode"`, giftDay)}
      WHERE wt."tenantId" = public.current_tenant_id() AND wt."direction" = 'credit'
        AND wt."reasonType"::text = ${WalletReasonType.coupon_redemption}
        AND wt."createdAt" >= ${r.from} AND wt."createdAt" < ${r.to}
    )
    SELECT public.current_tenant_id(), a."day", a."currencyCode", a."kind",
           SUM(a."started")::int, SUM(a."settled")::int, SUM(a."failed")::int,
           ${moneyAt(Prisma.sql`SUM(a."amount")`, Prisma.sql`a."currencyCode"`)}, ${moneyAt(Prisma.sql`SUM(a."gift")`, Prisma.sql`a."currencyCode"`)}
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

/**
 * `analytics_meter_day` (F-1001-n, ADR-0148 (2)): each meter's use per day,
 * product and panel. Usage events by the tenant day they happened on; but
 * `vpn.traffic` only from the network's daily aggregate — it covers package
 * Grants too, and counting its events as well would count a byte twice. That
 * aggregate is cut on UTC dates, as `bytesUsed` is. `grants` is the Grants
 * with any use in the cell.
 */
export async function writeMeters(tx: Prisma.TransactionClient, r: RollupRange): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO billing.analytics_meter_day ("tenantId", "day", "productId", "panelId", "meterKey", "quantity", "grants")
    WITH used AS (
      SELECT ${dayIn(Prisma.sql`e."occurredAt"`, r.zone)} AS "day", e."grantId", e."meterKey", e."quantity"
      FROM billing.usage_event e
      WHERE e."tenantId" = public.current_tenant_id() AND e."meterKey" <> ${METER_KEYS.vpnTraffic}
        AND e."occurredAt" >= ${r.from} AND e."occurredAt" < ${r.to}
      UNION ALL
      SELECT t."date", c."grantId", ${METER_KEYS.vpnTraffic}, (t."totalUploadBytes" + t."totalDownloadBytes")::bigint
      FROM network.traffic_daily_aggregate t
      JOIN network.config c ON c."id" = t."configId" AND c."tenantId" = public.current_tenant_id()
      WHERE t."date" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
    )
    SELECT public.current_tenant_id(), u."day", v."productId", pn."panelId", u."meterKey", SUM(u."quantity")::bigint, COUNT(DISTINCT u."grantId")::int
    FROM used u
    JOIN entitlement."grant" g ON g."id" = u."grantId"
    LEFT JOIN catalog.product_variant v ON v."id" = g."variantId"
    LEFT JOIN LATERAL (
      SELECT c."panelId" FROM network.config c WHERE c."grantId" = g."id" ORDER BY c."createdAt" LIMIT 1
    ) pn ON true
    GROUP BY u."day", v."productId", pn."panelId", u."meterKey"`;
}

/** The tenant's first day with anything to roll up — where a whole rebuild starts. */
export async function firstActivity(tx: Prisma.TransactionClient): Promise<Date | null> {
  const [row] = await tx.$queryRaw<{ at: Date | null }[]>`
    SELECT LEAST(
      (SELECT MIN(wt."createdAt") FROM billing.wallet_transaction wt WHERE wt."tenantId" = public.current_tenant_id()),
      (SELECT MIN(p."createdAt") FROM billing.payment_transaction p WHERE p."tenantId" = public.current_tenant_id()),
      -- A signup or a Grant before the first sale is a Customers figure too (F-1001-f).
      (SELECT MIN(s."signedUpAt") FROM billing.analytics_signup s WHERE s."tenantId" = public.current_tenant_id()),
      (SELECT MIN(g."startsAt") FROM entitlement."grant" g WHERE g."tenantId" = public.current_tenant_id())
    ) AS "at"`;
  return row?.at ?? null;
}
