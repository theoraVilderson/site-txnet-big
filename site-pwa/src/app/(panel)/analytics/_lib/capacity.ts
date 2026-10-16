import type { CapacityPanel } from "@/lib/billing/analytics";

/**
 * The Capacity tab's reading of billing's `capacity` (F-1005-b; billing
 * `contract.analytics-capacity.md`): how urgent a panel's full date is, and
 * its ratios. Pure, so the test holds the thresholds.
 */

/** A panel full within this many days is a warning: about the time it takes to buy and set up another. */
export const SOON_DAYS = 7;

export type Urgency = "full" | "soon" | "later" | "none";

/** Full today, within a week, later, or no full date at all. */
export function urgencyOf(p: Pick<CapacityPanel, "daysUntilFull">): Urgency {
  if (p.daysUntilFull === null) return "none";
  if (p.daysUntilFull === 0) return "full";
  return p.daysUntilFull <= SOON_DAYS ? "soon" : "later";
}

/** `part` of `whole`, 0..1 or past it; null without a whole. Bytes arrive as strings and stay exact until here. */
export function ratioOf(part: string | number | null, whole: string | number | null): number | null {
  if (part === null || whole === null) return null;
  const w = Number(whole);
  return w > 0 ? Number(part) / w : null;
}
