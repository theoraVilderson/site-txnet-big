import { z } from 'zod';

import type { Delta } from './analytics-figures';
import type { Day } from './analytics-days';

/**
 * A scheduled report's figures (F-1006-a, contract.analytics-reports.md
 * "What it says"): the Overview's headline KPIs for the period, in the
 * tenant's operating currency only (principle 6), each with its change —
 * as strings, the notice's params. auth-service writes them in the reader's
 * language and calendar; nothing here is words.
 */

const delta = z.union([z.number(), z.literal('new'), z.null()]);
const moneyFigure = z.object({ value: z.record(z.string()), delta: z.record(delta) });
const countFigure = z.object({ value: z.number(), delta });

/**
 * What the report reads of an Overview answer — checked, not assumed: the
 * answer comes back from the cache as JSON, and a report must not go out with
 * a figure that changed shape under it.
 */
export const reportKpisSchema = z.object({ kpis: z.object({ net: moneyFigure, topUps: moneyFigure, orders: countFigure, buyers: countFigure }) });
export type ReportKpis = z.infer<typeof reportKpisSchema>;

/** A change as a param: a ratio, `new` from zero, empty where nothing was compared. */
const deltaParam = (d: Delta | undefined) => (d === null || d === undefined ? '' : String(d));

export function reportParams(overview: ReportKpis, currency: string, period: { from: Day; to: Day }): Record<string, string> {
  const { net, topUps, orders, buyers } = overview.kpis;
  return {
    from: period.from,
    to: period.to,
    currencyCode: currency,
    net: net.value[currency] ?? '0',
    netDelta: deltaParam(net.delta[currency]),
    topUps: topUps.value[currency] ?? '0',
    topUpsDelta: deltaParam(topUps.delta[currency]),
    orders: String(orders.value),
    ordersDelta: deltaParam(orders.delta),
    buyers: String(buyers.value),
    buyersDelta: deltaParam(buyers.delta),
  };
}
