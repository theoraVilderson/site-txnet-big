import { Prisma } from '@prisma/client';

import { SALE_REASONS } from '../revenue/reseller-revenue.service';
import { Day, addDays, dayBounds } from './analytics-days';
import { RollupRange, dayIn } from './analytics-rollup';
import { RENEWAL_WINDOW_MAX_DAYS } from './analytics-settings';

/**
 * The Customers rollup (F-1001-f, billing/contract.analytics.md "Renewal"):
 * `analytics_grant_end` and `analytics_signup_day`, scoped by
 * `public.current_tenant_id()` as every rollup statement is.
 *
 * Both look back past the pass's window: a term that ended up to 30 days ago
 * can still renew today, and a signup up to 30 days ago can still buy. So a
 * pass rewrites the rows of `fromDay − LOOKBACK_DAYS`..`toDay`; a row older
 * than that can no longer change.
 */

/** The widest renewal window, and a day more, so the day its window closed is rewritten too. */
export const LOOKBACK_DAYS = RENEWAL_WINDOW_MAX_DAYS + 1;
/** Signup -> first purchase is counted within these many days. */
const PURCHASED_WITHIN_DAYS = [7, 30] as const;

/** `range` widened back by {@link LOOKBACK_DAYS}. */
export function customersRange(r: RollupRange): RollupRange {
  const fromDay = addDays(r.fromDay, -LOOKBACK_DAYS);
  return { ...r, fromDay, ...dayBounds(fromDay, r.toDay, r.zone) };
}

/** The state a term's end is in under `window` days, as of `today` — the one place the rule is written. */
const stateSql = (window: number, today: Day) => Prisma.sql`(CASE
  WHEN "renewedOn" IS NOT NULL AND abs("renewedOn" - "endedOn") <= ${window}::int THEN 'renewed'
  WHEN ${today}::date > "endedOn" + ${window}::int THEN 'lapsed'
  ELSE 'pending' END)::billing."AnalyticsRenewalState"`;

/**
 * Every term of the tenant that ended in `r`: a Grant's end now, once passed,
 * and an end an admin moved later (a renewal in place, F-311-d, or more days,
 * F-311-i) — renewed on the day it was moved, or on the end itself when it was
 * moved before. A cancelled Grant ended nothing. A term ended without being
 * moved renews by the same user starting a Grant of the same product: the
 * start nearest its end, within 30 days either side.
 */
export async function writeGrantEnds(tx: Prisma.TransactionClient, r: RollupRange, how: { window: number; today: Day; now: Date }): Promise<void> {
  // A pass over today reaches past now: a Grant ending later today is still running.
  const passed = how.now < r.to ? how.now : r.to;
  await tx.$executeRaw`DELETE FROM billing.analytics_grant_end WHERE "tenantId" = public.current_tenant_id() AND "endedOn" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date`;
  await tx.$executeRaw`
    INSERT INTO billing.analytics_grant_end ("tenantId", "grantId", "userId", "productId", "panelId", "endedOn", "renewedOn", "state")
    WITH moved AS (
      SELECT x."grantId", x."endsAtBefore", x."createdAt" FROM entitlement.grant_renewal x
      WHERE x."tenantId" = public.current_tenant_id() AND x."endsAtBefore" IS NOT NULL AND x."endsAtAfter" > x."endsAtBefore"
      UNION ALL
      SELECT x."grantId", x."endsAtBefore", x."createdAt" FROM entitlement.grant_duration_change x
      WHERE x."tenantId" = public.current_tenant_id() AND x."endsAtAfter" > x."endsAtBefore"
    ),
    ends AS (
      SELECT g."id" AS "grantId", ${dayIn(Prisma.sql`g."endsAt"`, r.zone)} AS "endedOn", NULL::date AS "movedOn"
      FROM entitlement."grant" g
      WHERE g."tenantId" = public.current_tenant_id() AND g."status" <> 'cancelled' AND g."endsAt" < ${passed}
      UNION ALL
      SELECT m."grantId", ${dayIn(Prisma.sql`m."endsAtBefore"`, r.zone)},
             GREATEST(${dayIn(Prisma.sql`m."createdAt"`, r.zone)}, ${dayIn(Prisma.sql`m."endsAtBefore"`, r.zone)})
      FROM moved m
    ),
    judged AS (
      SELECT DISTINCT ON (e."grantId", e."endedOn") g."id" AS "grantId", g."userId", v."productId", pn."panelId", e."endedOn",
             COALESCE(e."movedOn", (
               SELECT ${dayIn(Prisma.sql`n."startsAt"`, r.zone)} FROM entitlement."grant" n
               JOIN catalog.product_variant nv ON nv."id" = n."variantId"
               WHERE n."tenantId" = public.current_tenant_id() AND n."userId" = g."userId" AND nv."productId" = v."productId"
                 AND n."id" <> g."id" AND n."startsAt" > g."startsAt" AND n."status" <> 'cancelled' AND n."startsAt" < ${r.to}
                 AND abs(${dayIn(Prisma.sql`n."startsAt"`, r.zone)} - e."endedOn") <= ${RENEWAL_WINDOW_MAX_DAYS}::int
               ORDER BY abs(${dayIn(Prisma.sql`n."startsAt"`, r.zone)} - e."endedOn"), n."startsAt" LIMIT 1
             )) AS "renewedOn"
      FROM ends e
      JOIN entitlement."grant" g ON g."id" = e."grantId"
      LEFT JOIN catalog.product_variant v ON v."id" = g."variantId"
      LEFT JOIN LATERAL (
        SELECT c."panelId" FROM network.config c WHERE c."grantId" = g."id" ORDER BY c."createdAt" LIMIT 1
      ) pn ON true
      WHERE e."endedOn" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
      ORDER BY e."grantId", e."endedOn", e."movedOn" NULLS LAST
    )
    SELECT public.current_tenant_id(), j."grantId", j."userId", j."productId", j."panelId", j."endedOn", j."renewedOn", ${stateSql(how.window, how.today)}
    FROM judged j`;
}

/** Every term end of the tenant re-stated under a new window — what a setting change does, without a rebuild. */
export async function restateGrantEnds(tx: Prisma.TransactionClient, how: { window: number; today: Day }): Promise<number> {
  return tx.$executeRaw`UPDATE billing.analytics_grant_end SET "state" = ${stateSql(how.window, how.today)} WHERE "tenantId" = public.current_tenant_id()`;
}

/**
 * Signups per tenant day and source in `r`, from `analytics_signup` (identity's
 * event, never its tables), and how many of each made their first purchase
 * ever — the first sale `/revenue` counts — within 7 and 30 days.
 */
export async function writeSignups(tx: Prisma.TransactionClient, r: RollupRange): Promise<void> {
  const [within7, within30] = PURCHASED_WITHIN_DAYS;
  await tx.$executeRaw`DELETE FROM billing.analytics_signup_day WHERE "tenantId" = public.current_tenant_id() AND "day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date`;
  await tx.$executeRaw`
    INSERT INTO billing.analytics_signup_day ("tenantId", "day", "source", "signups", "purchased7", "purchased30")
    WITH su AS (
      SELECT s."userId", s."source", s."signedUpAt", ${dayIn(Prisma.sql`s."signedUpAt"`, r.zone)} AS "day"
      FROM billing.analytics_signup s
      WHERE s."tenantId" = public.current_tenant_id() AND s."signedUpAt" >= ${r.from} AND s."signedUpAt" < ${r.to}
    ),
    firsts AS (
      SELECT w."ownerUserId" AS "userId", MIN(wt."createdAt") AS "at"
      FROM billing.wallet_transaction wt
      JOIN billing.wallet w ON w."id" = wt."walletId"
      WHERE wt."tenantId" = public.current_tenant_id() AND wt."direction" = 'debit' AND wt."reasonType"::text = ANY(${SALE_REASONS})
        AND w."ownerUserId" IN (SELECT "userId" FROM su)
      GROUP BY w."ownerUserId"
    )
    SELECT public.current_tenant_id(), su."day", su."source", COUNT(*)::int,
           (COUNT(*) FILTER (WHERE f."at" < su."signedUpAt" + make_interval(days => ${within7}::int)))::int,
           (COUNT(*) FILTER (WHERE f."at" < su."signedUpAt" + make_interval(days => ${within30}::int)))::int
    FROM su LEFT JOIN firsts f ON f."userId" = su."userId"
    GROUP BY su."day", su."source"`;
}

/** The two tables' rows in the widened range, for the pass's before/after digest. */
export async function customersFingerprint(tx: Prisma.TransactionClient, r: RollupRange): Promise<string> {
  const [row] = await tx.$queryRaw<{ digest: string }[]>`
    SELECT md5(COALESCE(string_agg(x, '|' ORDER BY x), '')) AS "digest" FROM (
      SELECT 'g' || row(g."grantId", g."endedOn", g."renewedOn", g."state", g."productId", g."panelId")::text AS x
        FROM billing.analytics_grant_end g WHERE g."tenantId" = public.current_tenant_id() AND g."endedOn" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
      UNION ALL
      SELECT 'n' || row(n."day", n."source", n."signups", n."purchased7", n."purchased30")::text
        FROM billing.analytics_signup_day n WHERE n."tenantId" = public.current_tenant_id() AND n."day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
    ) q`;
  return row?.digest ?? '';
}
