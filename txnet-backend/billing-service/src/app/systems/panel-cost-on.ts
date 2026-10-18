import type { Prisma } from '@prisma/client';
import { moneyText } from '@txnet-backend/shared-core';

/** Panels are bought in dollars (network `contract.panel-cost.md` rule 5). */
export const PANEL_CURRENCY = 'USD';

/**
 * Which of a panel's prices is in effect on a day (F-1002-a) — pure, so the
 * systems list and the cost routes read a price the same way.
 */

/** A price row as read: what `costOn` and `viewOf` need of `network.panel_cost`. */
export type CostRow = { monthlyCostUsd: Prisma.Decimal; effectiveFrom: Date; createdByUserId: string | null; createdAt: Date; monthlyTrafficBytes?: bigint | null };

/** One price as answered: money a decimal string, the day a date. */
export type PanelCostView = { monthlyCostUsd: string; monthlyTrafficBytes: string | null; effectiveFrom: string; createdByUserId: string | null; createdAt: string };

/** The UTC day of an instant, `YYYY-MM-DD`. */
export const dayOf = (at: Date) => at.toISOString().slice(0, 10);
/** A price as answered. */
export const viewOf = (r: CostRow): PanelCostView => ({
  monthlyCostUsd: moneyText(r.monthlyCostUsd),
  // Bytes as a decimal string: a month's allowance passes 2^53 on a large server.
  monthlyTrafficBytes: r.monthlyTrafficBytes?.toString() ?? null,
  effectiveFrom: dayOf(r.effectiveFrom),
  createdByUserId: r.createdByUserId,
  createdAt: r.createdAt.toISOString(),
});

/** The price on `day`: the latest `effectiveFrom` on or before it, the later written of one day; none before the first. */
export function costOn<R extends CostRow>(history: readonly R[], on: string): R | null {
  let best: R | null = null;
  for (const r of history) {
    if (dayOf(r.effectiveFrom) > on) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom || (r.effectiveFrom.getTime() === best.effectiveFrom.getTime() && r.createdAt > best.createdAt)) best = r;
  }
  return best;
}

