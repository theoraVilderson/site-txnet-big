import { Prisma } from '@prisma/client';

import { bucketsOf } from './analytics-buckets';
import { TabContext, dayMap } from './analytics-context';
import { CohortGrid, CohortInput, cohortGridOf } from './analytics-cohort-grid';
import type { Day } from './analytics-days';
import { currenciesOf } from './analytics-figures';

/** The grid as flat rows (cohort sizes, cohort · k cells, channel sizes, channel · k LTV — the channel is the signup source, ADR-0149 (5)). */
export type CohortsTab = CohortGrid & {
  currencies: string[];
  /** The window's months, in the reader's calendar: a cohort is one of them, and month k counts from it. */
  months: Day[];
};

/**
 * Each first buyer of the window, by cohort month and signup source, and per
 * month after it their activity and net — read from the rollup only
 * (principle 1). A first purchase is `analytics_user_day.firstPurchase`; a
 * user with no `analytics_signup` row reads `unknown`. `m` cuts both days by
 * the same month map, so a cohort and its months share keys.
 */
async function readCohorts(c: TabContext, months: { days: Day[]; keys: Day[] }): Promise<Omit<CohortInput, 'months'>> {
  const base = Prisma.sql`
    WITH m AS (SELECT * FROM unnest(${months.days}::date[], ${months.keys}::date[]) AS m("day", "bucket")),
    cohort AS (
      SELECT f."userId", mf."bucket" AS "cohort", COALESCE(s."source", 'unknown') AS "source"
      FROM (SELECT u."userId", MIN(u."day") AS "day" FROM billing.analytics_user_day u
            WHERE u."tenantId" = public.current_tenant_id() AND u."firstPurchase" GROUP BY 1) f
      JOIN m mf ON mf."day" = f."day"
      LEFT JOIN billing.analytics_signup s ON s."userId" = f."userId"
    ),
    act AS (
      SELECT u."userId", ma."bucket" AS "month", u."currencyCode", SUM(u."net") AS "net", BOOL_OR(u."net" <> 0 OR u."orders" <> 0) AS "active"
      FROM billing.analytics_user_day u JOIN m ma ON ma."day" = u."day"
      WHERE u."tenantId" = public.current_tenant_id()
      GROUP BY 1, 2, 3
    )`;
  const sizes = await c.tx.$queryRaw<CohortInput['sizes']>`
    ${base} SELECT to_char(k."cohort", 'YYYY-MM-DD') AS "cohort", k."source", COUNT(*)::int AS "users" FROM cohort k GROUP BY 1, 2`;
  // A member active in two currencies in one month is one person: counted apart from the money.
  const active = await c.tx.$queryRaw<CohortInput['active']>`
    ${base} SELECT to_char(k."cohort", 'YYYY-MM-DD') AS "cohort", to_char(a."month", 'YYYY-MM-DD') AS "month", k."source", COUNT(DISTINCT a."userId")::int AS "users"
    FROM cohort k JOIN act a ON a."userId" = k."userId" WHERE a."active" GROUP BY 1, 2, 3`;
  const net = await c.tx.$queryRaw<CohortInput['net']>`
    ${base} SELECT to_char(k."cohort", 'YYYY-MM-DD') AS "cohort", to_char(a."month", 'YYYY-MM-DD') AS "month", k."source", a."currencyCode", SUM(a."net") AS "net"
    FROM cohort k JOIN act a ON a."userId" = k."userId" GROUP BY 1, 2, 3, 4`;
  return { sizes, active, net };
}

/**
 * The Cohorts tab (F-1004-a, contract.analytics-tabs.md "Cohorts"): the
 * window's first buyers by the month of their first purchase, in the reader's
 * calendar; per month k the share still buying, net per member and cumulative
 * LTV; and the LTV curve per signup source. Months are counted up to the
 * window's end. A cohort is a set of people: product, panel and kind filters
 * do not narrow it.
 */
export async function cohortsOf(c: TabContext): Promise<CohortsTab> {
  const cut = bucketsOf(c.window.from, c.window.to, 'month', c.calendar);
  const rows = await readCohorts(c, dayMap(c.window, cut.keyOf));
  const currencies = currenciesOf(c.operating, rows.net.map((r) => r.currencyCode));
  return { currencies, months: cut.keys, ...cohortGridOf({ months: cut.keys, ...rows }, { currencies, hides: c.hides, places: c.places }) };
}
