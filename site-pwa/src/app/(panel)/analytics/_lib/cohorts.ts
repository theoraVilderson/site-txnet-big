import type { AnalyticsCohorts } from "@/lib/billing/analytics";
import { amountIn } from "./overview";

/** What the grid shows, one at a time (one question per card): the share still buying, net per member, cumulative LTV. */
export const COHORT_METRICS = ["share", "netPerUser", "ltv"] as const;
export type CohortMetric = (typeof COHORT_METRICS)[number];

/** A cohort as the grid draws it: its size and one value per month k (null: not lived yet), or hidden from the reader. */
export type GridRow = { cohort: string; users: number; values: (number | null)[] } | { cohort: string; hidden: true };

/** Billing's flat cells pivoted by cohort and month k, in `metric` — money in one currency (principle 6). */
export function gridOf(answer: AnalyticsCohorts, metric: CohortMetric, currency: string): { columns: number; rows: GridRow[] } {
  const columns = answer.months.length;
  const rows = answer.cohorts.map((c): GridRow => {
    if (!("users" in c)) return { cohort: c.cohort, hidden: true };
    const values: (number | null)[] = Array.from({ length: columns }, () => null);
    for (const cell of answer.cells) if (cell.cohort === c.cohort && cell.k < columns) values[cell.k] = metric === "share" ? cell.share : amountIn(cell[metric], currency);
    return { cohort: c.cohort, users: c.users, values };
  });
  return { columns, rows };
}

/** Each channel billing showed, its LTV per month k in one currency — null past the last month it reached. */
export function channelCurves(answer: AnalyticsCohorts, currency: string, columns: number): { source: string; values: (number | null)[] }[] {
  return answer.channels.flatMap((c) => {
    if (!("users" in c)) return [];
    const values: (number | null)[] = Array.from({ length: columns }, () => null);
    for (const p of answer.channelLtv) if (p.source === c.source && p.k < columns) values[p.k] = amountIn(p.ltv, currency);
    return [{ source: c.source, values }];
  });
}
