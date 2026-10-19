import { Prisma, WalletReasonType } from '@prisma/client';
import { METER_KEYS } from '@txnet-backend/shared-core';

import { addDays, dayOf, type Day } from './analytics-days';
import { CommissionedPayment, CostDayRow, Expense, SaleCost, UsageCost, gatewayCommissionCosts, ownCosts, spreadExpenses } from './analytics-cost';
import { RollupRange, dayIn } from './analytics-rollup';

/**
 * The tenant's own costs (F-1002-e, ADR-0151, billing `contract.analytics-tabs.md`
 * "Cost attribution" rule 5): what its sales and its users' metered use cost
 * it, from catalog's `variant_cost` and `meter_cost` (RLS: its own rows only).
 * The arithmetic is `ownCosts`'s; this file reads the facts.
 */

/** A Grant's panel: its first config's, as a sale's panel is (`analytics-rollup.ts`). */
const panelOf = (grant: Prisma.Sql) => Prisma.sql`(SELECT c."panelId" FROM network.config c WHERE c."grantId" = ${grant} ORDER BY c."createdAt" LIMIT 1)`;

/**
 * Each purchase and the refund that undoes it in `r`, at its variant's cost in
 * effect when the invoice was made — none where that cost was taken back
 * (F-1002-i).
 */
function readSaleCosts(tx: Prisma.TransactionClient, r: RollupRange): Promise<SaleCost[]> {
  return tx.$queryRaw`
    SELECT to_char(${dayIn(Prisma.sql`wt."createdAt"`, r.zone)}, 'YYYY-MM-DD') AS "day", vc."currencyCode", vc."amount" AS "cost",
           wt."direction" = 'debit' AS "sale", v."productId", w."ownerUserId" AS "userId",
           ${panelOf(Prisma.sql`(SELECT g."id" FROM entitlement."grant" g WHERE g."sourceReferenceId" = i."id" ORDER BY g."createdAt" LIMIT 1)`)} AS "panelId"
    FROM billing.wallet_transaction wt
    JOIN billing.wallet w ON w."id" = wt."walletId"
    JOIN billing.invoice i ON i."id" = wt."referenceId"
    JOIN catalog.product_variant v ON v."id" = i."variantId"
    JOIN LATERAL (
      SELECT c."amount", c."currencyCode" FROM catalog.variant_cost c
      WHERE c."variantId" = i."variantId" AND c."tenantId" = public.current_tenant_id() AND c."effectiveFrom" <= i."createdAt"
      ORDER BY c."effectiveFrom" DESC, c."createdAt" DESC LIMIT 1
    ) vc ON vc."amount" IS NOT NULL
    WHERE wt."tenantId" = public.current_tenant_id() AND wt."createdAt" >= ${r.from} AND wt."createdAt" < ${r.to}
      AND ((wt."direction" = 'debit' AND wt."reasonType"::text = ${WalletReasonType.product_purchase})
        OR (wt."direction" = 'credit' AND wt."reasonType"::text = ${WalletReasonType.product_refund}))`;
}

/**
 * Each Grant's use of a meter per tenant day in `r`, at the meter's unit cost
 * in effect when it happened — never `vpn.traffic` (its panels'), and never a
 * meter the tenant pays the platform wholesale for (that charge is its cost).
 */
function readUsageCosts(tx: Prisma.TransactionClient, r: RollupRange): Promise<UsageCost[]> {
  return tx.$queryRaw`
    SELECT to_char(${dayIn(Prisma.sql`e."occurredAt"`, r.zone)}, 'YYYY-MM-DD') AS "day", mc."currencyCode", SUM(e."quantity")::bigint AS "quantity",
           mc."unitSize", mc."unitCost", v."productId", g."userId", ${panelOf(Prisma.sql`g."id"`)} AS "panelId"
    FROM billing.usage_event e
    JOIN entitlement."grant" g ON g."id" = e."grantId"
    LEFT JOIN catalog.product_variant v ON v."id" = g."variantId"
    JOIN LATERAL (
      SELECT c."unitSize", c."unitCost", c."currencyCode" FROM catalog.meter_cost c
      WHERE c."meterKey" = e."meterKey" AND c."tenantId" = public.current_tenant_id() AND c."effectiveFrom" <= e."occurredAt"
      ORDER BY c."effectiveFrom" DESC, c."createdAt" DESC LIMIT 1
    ) mc ON mc."unitCost" IS NOT NULL
    WHERE e."tenantId" = public.current_tenant_id() AND e."meterKey" <> ${METER_KEYS.vpnTraffic}
      AND e."occurredAt" >= ${r.from} AND e."occurredAt" < ${r.to}
      AND NOT EXISTS (
        SELECT 1 FROM entitlement.grant_meter gm
        WHERE gm."grantId" = e."grantId" AND gm."meterKey" = e."meterKey" AND gm."wholesalePayerTenantId" IS NOT NULL
      )
    GROUP BY 1, 2, 4, 5, 6, 7, 8`;
}

/** The tenant's general expenses still standing whose months reach into `r` (F-1001-t): none taken back. */
function readExpenses(tx: Prisma.TransactionClient, r: RollupRange): Promise<Expense[]> {
  return tx.$queryRaw`
    SELECT to_char(e."spentOn", 'YYYY-MM-DD') AS "spentOn", e."months"::int AS "months", e."amount", e."currencyCode"
    FROM billing.general_expense e
    WHERE e."tenantId" = public.current_tenant_id() AND e."spentOn" <= ${r.toDay}::date
      AND (e."spentOn" + make_interval(months => e."months"))::date > ${r.fromDay}::date
      AND NOT EXISTS (SELECT 1 FROM billing.general_expense_take_back t WHERE t."expenseId" = e."id")`;
}

/**
 * Each payment settled in `r` on a gateway the tenant owns, with the
 * commission its provider was set to deduct on the payment's tenant day
 * (F-1001-v) — none before a gateway's first. A granted gateway's payment is
 * left out: the money landed in its lender's merchant account, and the
 * settlement already nets the fee there (ADR-0041 §4). A free top-up was
 * charged nothing.
 */
function readCommissionedPayments(tx: Prisma.TransactionClient, r: RollupRange): Promise<CommissionedPayment[]> {
  const day = dayIn(Prisma.sql`p."createdAt"`, r.zone);
  return tx.$queryRaw`
    SELECT to_char(${day}, 'YYYY-MM-DD') AS "day", p."currencyCode", p."amountCredited" AS "credited", p."discountApplied" AS "discount",
           p."feeApplied" AS "fee", p."taxApplied" AS "tax", gc."percent", gc."fixedAmount", gc."currencyCode" AS "fixedCurrencyCode"
    FROM billing.payment_transaction p
    JOIN LATERAL (
      SELECT c."percent", c."fixedAmount", c."currencyCode" FROM billing.gateway_commission c
      WHERE (c."gatewayId" = p."gatewayId" OR c."tenantGatewayConfigId" = p."tenantGatewayConfigId")
        AND c."tenantId" = public.current_tenant_id() AND c."effectiveFrom" <= ${day}::date
      ORDER BY c."effectiveFrom" DESC, c."createdAt" DESC LIMIT 1
    ) gc ON true
    WHERE p."tenantId" = public.current_tenant_id() AND p."status" = 'success' AND p."grantId" IS NULL AND p."chargedAmountMinor" > 0
      AND p."createdAt" >= ${r.from} AND p."createdAt" < ${r.to}`;
}

/** The tenant's sale and usage costs in `r`, its general expenses spread over their days, and its gateways' commissions, as cost rows. */
export async function readOwnCosts(tx: Prisma.TransactionClient, r: RollupRange): Promise<CostDayRow[]> {
  return [
    ...ownCosts(await readSaleCosts(tx, r), await readUsageCosts(tx, r)),
    ...spreadExpenses(await readExpenses(tx, r), { from: r.fromDay, to: r.toDay }),
    ...gatewayCommissionCosts(await readCommissionedPayments(tx, r)),
  ];
}

/**
 * Asks the next rollup pass to restate `tenantId`'s cost rows from the day
 * before `from` on (UTC, one day early so every zone's day is covered) — what
 * a cost written for past days calls, in its own transaction (F-1002-e). The
 * earliest of two asks wins. A tenant never rolled has nothing to restate.
 */
export async function restateCostsFrom(tx: Prisma.TransactionClient, tenantId: string, from: Date): Promise<void> {
  const day: Day = addDays(dayOf(from, 'UTC'), -1);
  await tx.$executeRaw`
    UPDATE billing.analytics_rollup_state SET "costsFrom" = LEAST(COALESCE("costsFrom", ${day}::date), ${day}::date)
    WHERE "tenantId" = ${tenantId}::uuid`;
}
