import type { CostRow } from "@/lib/catalog-cost-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

/**
 * The cost forms' rules (F-1002-g, ADR-0151) — billing's, said before the
 * request: a cost per sale to the cent and 0 or more, a unit cost to 8 places
 * (a rate card's precision), a unit size a whole number of at least 1.
 */

const E = FrontendI18nKeys.common.catalog.cost.errors;
/** Billing's `decimal`: 0 or more, at most two places. */
const PER_SALE = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
/** Billing's `UNIT_PRICE`: at most eight places. */
const PER_UNITS = /^(0|[1-9]\d{0,9})(\.\d{1,8})?$/;
const WHOLE = /^[1-9]\d{0,17}$/;

/** When a new cost starts: now, or the 1st of this UTC month — billing's earliest, which also costs this month's sales. */
export const COST_FROM = ["now", "monthStart"] as const;
export type CostFrom = (typeof COST_FROM)[number];

/** The error key for a cost per sale, or null. */
export function validateVariantCost(amount: string): string | null {
  return PER_SALE.test(amount.trim()) ? null : E.amount;
}

/** The error keys of a meter cost form, by field. */
export function validateMeterCost(f: { unitSize: string; unitCost: string }): Partial<Record<"unitSize" | "unitCost", string>> {
  const errors: Partial<Record<"unitSize" | "unitCost", string>> = {};
  if (!WHOLE.test(f.unitSize.trim())) errors.unitSize = E.unitSize;
  if (!PER_UNITS.test(f.unitCost.trim())) errors.unitCost = E.unitCost;
  return errors;
}

/** The `effectiveFrom` billing is sent: none for now, the 1st of this UTC month's first instant otherwise. */
export function costFrom(from: CostFrom, now: Date = new Date()): string | undefined {
  return from === "now" ? undefined : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Is there a cost in effect — a row, and not a take-back (F-1002-j)? 0 is a cost; a `null` amount or no row is "no cost set". */
export function isCostSet<R extends CostRow>(row: R | null): row is R & { amount: string } {
  return row !== null && row.amount !== null;
}

/** The newest cost row already in effect at `now` — a take-back included — or none. */
export function currentCost<R extends CostRow>(rows: readonly R[], now: Date = new Date()): R | null {
  let best: R | null = null;
  for (const r of rows) {
    const at = new Date(r.effectiveFrom).getTime();
    if (at > now.getTime()) continue;
    if (!best || at > new Date(best.effectiveFrom).getTime()) best = r;
  }
  return best;
}
