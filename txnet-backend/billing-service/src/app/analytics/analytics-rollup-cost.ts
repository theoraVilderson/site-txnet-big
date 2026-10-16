import { Prisma, TenantBillingReasonType } from '@prisma/client';
import { operatingCurrencyOf } from '@txnet-backend/shared-core';

import { CostDayRow, PanelUse, ResellerCharge, WholesaleUse, attributePanelCosts, attributeWholesale, spreadSubscriptions } from './analytics-cost';
import { ConvertedCost, convertCosts, rateLookup, readRates } from './analytics-fx';
import type { CrossTenantReader } from './analytics-context';
import { Day, addDays, dayOf } from './analytics-days';
import { RollupRange, dayIn } from './analytics-rollup';

/**
 * The cost rollup (F-1002-b): the reads and the write around the arithmetic of
 * `analytics-cost.ts`. Every write is scoped by `public.current_tenant_id()`.
 *
 * Panel costs are cut on the **UTC date**: they are split by the network's
 * daily aggregate, which is cut there (as `bytesUsed` is). A reseller's
 * charges land on its own tenant day and split by the bytes of the same date.
 */

/** The longest a subscription period runs (a year, a leap year's): how far back a charge can still cover the window. */
const LONGEST_PERIOD_DAYS = 366;

const ZERO = new Prisma.Decimal(0);

const datesOf = (r: RollupRange): Day[] => {
  const out: Day[] = [];
  for (let day = r.fromDay; day <= r.toDay; day = addDays(day, 1)) out.push(day);
  return out;
};

/**
 * The platform's panels' every price — `network.panel`'s policy shows them to
 * the platform's scope — and every Grant's bytes on them by UTC date, through
 * `across`: a reseller's users ride the platform's panels too, and their
 * configs are theirs. A reseller's Grant names its tenant and nothing else.
 */
async function platformPanelCosts(tx: Prisma.TransactionClient, across: CrossTenantReader, r: RollupRange & { tenantId: string }): Promise<CostDayRow[]> {
  const prices = await tx.$queryRaw<{ panelId: string; monthlyCostUsd: Prisma.Decimal; effectiveFrom: Date; createdByUserId: string | null; createdAt: Date }[]>`
    SELECT pc."panelId", pc."monthlyCostUsd", pc."effectiveFrom", pc."createdByUserId", pc."createdAt"
    FROM network.panel_cost pc JOIN network.panel p ON p."id" = pc."panelId"
    WHERE p."ownershipType" = 'platform' AND pc."effectiveFrom" <= ${r.toDay}::date`;
  if (prices.length === 0) return [];
  const use = await across.$queryRaw<(Omit<PanelUse, 'bytes'> & { bytes: bigint })[]>`
    SELECT to_char(t."date", 'YYYY-MM-DD') AS "day", c."panelId", c."tenantId" AS "servedTenantId",
           CASE WHEN c."tenantId" = ${r.tenantId}::uuid THEN v."productId" END AS "productId",
           CASE WHEN c."tenantId" = ${r.tenantId}::uuid THEN g."userId" END AS "userId",
           SUM(t."totalUploadBytes" + t."totalDownloadBytes")::bigint AS "bytes"
    FROM network.traffic_daily_aggregate t
    JOIN network.config c ON c."id" = t."configId"
    JOIN network.panel p ON p."id" = c."panelId" AND p."ownershipType" = 'platform'
    JOIN entitlement."grant" g ON g."id" = c."grantId"
    LEFT JOIN catalog.product_variant v ON v."id" = g."variantId"
    WHERE t."date" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
    GROUP BY 1, 2, 3, 4, 5`;
  return attributePanelCosts(datesOf(r), prices, use);
}

/** A reseller's payments to the platform in `r` of `reasons`, signed (a charge +, a refund −), on its tenant day. */
function readResellerCharges(tx: Prisma.TransactionClient, r: RollupRange, reasons: readonly TenantBillingReasonType[], from: Date): Promise<ResellerCharge[]> {
  return tx.$queryRaw<ResellerCharge[]>`
    SELECT to_char(${dayIn(Prisma.sql`b."createdAt"`, r.zone)}, 'YYYY-MM-DD') AS "day", b."currencyCode",
           CASE WHEN b."direction" = 'debit' THEN b."amount" ELSE -b."amount" END AS "amount"
    FROM tenant.tenant_billing_transaction b
    JOIN tenant.tenant_billing_wallet w ON w."id" = b."walletId" AND w."tenantId" = public.current_tenant_id()
    WHERE b."reasonType"::text = ANY(${[...reasons]}) AND b."createdAt" >= ${from} AND b."createdAt" < ${r.to}`;
}

/**
 * What a reseller pays the platform (contract "Cost and margin"): per-use
 * charges net of refunds split by its bytes on the platform's panels per
 * product, and each subscription charge spread over its period's days.
 */
async function resellerCosts(tx: Prisma.TransactionClient, r: RollupRange): Promise<CostDayRow[]> {
  const wholesale = await readResellerCharges(tx, r, [TenantBillingReasonType.metered_usage_charge, TenantBillingReasonType.metered_usage_refund], r.from);
  const use = wholesale.length
    ? await tx.$queryRaw<WholesaleUse[]>`
        SELECT to_char(t."date", 'YYYY-MM-DD') AS "day", v."productId", c."panelId", g."userId", SUM(t."totalUploadBytes" + t."totalDownloadBytes")::bigint AS "bytes"
        FROM network.traffic_daily_aggregate t
        JOIN network.config c ON c."id" = t."configId" AND c."tenantId" = public.current_tenant_id()
        JOIN network.panel p ON p."id" = c."panelId" AND p."ownershipType" = 'platform'
        JOIN entitlement."grant" g ON g."id" = c."grantId"
        LEFT JOIN catalog.product_variant v ON v."id" = g."variantId"
        WHERE t."date" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
        GROUP BY 1, 2, 3, 4`
    : [];
  // A charge up to a year before the window may still cover its days.
  const since = new Date(r.from.getTime() - LONGEST_PERIOD_DAYS * 86_400_000);
  const subscriptions = (await readResellerCharges(tx, r, [TenantBillingReasonType.subscription_charge], since)).filter((c) => c.amount.gt(ZERO));
  const period = subscriptions.length ? await tx.tenantSubscription.findFirst({ select: { currentPeriodEnd: true } }) : null;
  return [
    ...attributeWholesale(wholesale, use),
    ...spreadSubscriptions(subscriptions, { periodEnd: period ? dayOf(period.currentPeriodEnd, r.zone) : null, window: { from: r.fromDay, to: r.toDay } }),
  ];
}

/** `rows` into `analytics_cost_day`, one statement. */
async function insertCosts(tx: Prisma.TransactionClient, rows: readonly ConvertedCost[]): Promise<void> {
  if (rows.length === 0) return;
  const col = <T>(pick: (row: ConvertedCost) => T) => rows.map(pick);
  // An array of nulls only is sent as integer[]: an id column goes through text[] to reach uuid[].
  await tx.$executeRaw`
    INSERT INTO billing.analytics_cost_day ("tenantId", "day", "kind", "panelId", "servedTenantId", "productId", "userId", "currencyCode", "cost", "bytes", "saleCurrencyCode", "saleCost")
    SELECT public.current_tenant_id(), x."day", x."kind"::billing."AnalyticsCostKind", x."panelId", x."servedTenantId", x."productId", x."userId", x."currencyCode", x."cost", x."bytes", x."saleCurrencyCode", x."saleCost"
    FROM unnest(
      ${col((x) => x.day)}::date[], ${col((x) => x.kind)}::text[], ${col((x) => x.panelId)}::text[]::uuid[], ${col((x) => x.servedTenantId)}::text[]::uuid[],
      ${col((x) => x.productId)}::text[]::uuid[], ${col((x) => x.userId)}::text[]::uuid[], ${col((x) => x.currencyCode)}::text[],
      ${col((x) => x.cost.toFixed(6))}::numeric[], ${col((x) => x.bytes.toString())}::bigint[],
      ${col((x) => x.saleCurrencyCode)}::text[], ${col((x) => x.saleCost?.toFixed(6) ?? null)}::text[]::numeric[]
    ) AS x("day", "kind", "panelId", "servedTenantId", "productId", "userId", "currencyCode", "cost", "bytes", "saleCurrencyCode", "saleCost")`;
}

/** `rows` in the tenant's operating currency now, each at its own day's rate (ADR-0149). */
async function inSaleCurrency(tx: Prisma.TransactionClient, tenantId: string, rows: readonly CostDayRow[]): Promise<ConvertedCost[]> {
  if (rows.length === 0) return [];
  const operating = await operatingCurrencyOf(tx, tenantId);
  const foreign = rows.filter((x) => x.currencyCode !== operating);
  const rates = await readRates(tx, [operating, ...foreign.map((x) => x.currencyCode)], [...new Set(foreign.map((x) => x.day))]);
  return convertCosts(rows, operating, rateLookup(rates));
}

/**
 * `analytics_cost_day` for the tenant in scope (`r.tenantId`) and `r`: the
 * platform's panel costs when it is the platform — its own users and products
 * named, a reseller's Grant only by its tenant — and what it pays the
 * platform when it is a reseller, down to its own users. Each source is
 * grouped to the grain already; each row also in the operating currency.
 */
export async function writeCosts(tx: Prisma.TransactionClient, r: RollupRange & { tenantId: string }, how: { platform: boolean; across: CrossTenantReader }): Promise<void> {
  await tx.$executeRaw`DELETE FROM billing.analytics_cost_day WHERE "tenantId" = public.current_tenant_id() AND "day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date`;
  const rows = how.platform ? await platformPanelCosts(tx, how.across, r) : await resellerCosts(tx, r);
  await insertCosts(tx, await inSaleCurrency(tx, r.tenantId, rows));
}
