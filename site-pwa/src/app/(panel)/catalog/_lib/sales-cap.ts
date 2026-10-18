/**
 * A variant's sales and active caps as the catalog page writes them (F-513-c, F-514-d, catalog
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

/** A variant's two caps, both billing's 1..{@link MAX_SALES_CAP} (F-513, F-514; `contract.sales-cap.md` "HTTP surface"). */
export const CAP_FIELDS = ["salesCap", "activeCap"] as const;
export type CapField = (typeof CAP_FIELDS)[number];

/** The caps typed into a new variant's form as billing's body: a blank or invalid box sends none (F-513-e, F-514-d). */
export function capsOf(form: Record<CapField, string>): Partial<Record<CapField, number>> {
  return Object.fromEntries(CAP_FIELDS.flatMap((k) => {
    const cap = parseSalesCap(form[k]);
    return cap === null ? [] : [[k, cap]];
  }));
}
