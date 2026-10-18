/**
 * A variant's sales cap as the catalog page writes it (F-513-c, catalog
 * `contract.sales-cap.md`): billing's schema takes a whole number
 * 1..{@link MAX_SALES_CAP} or `null`, so the page refuses anything else first.
 */

/** Billing's `MAX_SALES_CAP` — a typo guard, not a business limit; `sold-out.test.tsx` holds the two equal. */
export const MAX_SALES_CAP = 1_000_000;

/** The cap typed into the box, or `null` when it is not one billing would take. */
export function parseSalesCap(input: string): number | null {
  const typed = input.trim();
  if (!/^\d+$/.test(typed)) return null;
  const cap = Number(typed);
  return cap >= 1 && cap <= MAX_SALES_CAP ? cap : null;
}
