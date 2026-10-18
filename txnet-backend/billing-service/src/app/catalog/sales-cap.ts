/**
 * A variant's sales cap (F-513-a, catalog F-513): at most `salesCap` sold, then
 * sold out. A pending invoice holds a unit as a sale does, so the cap is never
 * oversold by two buyers paying at once (F-513-b writes the counts).
 */

/** The largest cap an admin may set — a typo guard, not a business limit. */
export const MAX_SALES_CAP = 1_000_000;

/** The three columns a cap is read from. */
export type SalesCounts = { salesCap: number | null; soldCount: number; reservedCount: number };

/** A variant's cap as the routes and the shop answer it. `remaining` is `null` with no cap. */
export type SalesView = { cap: number | null; sold: number; reserved: number; remaining: number | null; soldOut: boolean };

/**
 * What is left to sell. A cap lowered under what is sold and held leaves 0,
 * never a negative: sales close, and none is undone (user, 2026-10-18).
 */
export function salesOf(v: SalesCounts): SalesView {
  const remaining = v.salesCap === null ? null : Math.max(0, v.salesCap - v.soldCount - v.reservedCount);
  return { cap: v.salesCap, sold: v.soldCount, reserved: v.reservedCount, remaining, soldOut: remaining === 0 };
}

/**
 * A variant's active cap (F-514-a, catalog F-514): at most `activeCap` live
 * services at once — a Grant `pending`, `active` or `suspended` — beside the
 * lifetime cap above. `liveCount` is counted from the grants themselves
 * (`liveGrantsOf`), never kept as a counter; a pending invoice's hold takes a
 * slot here as it takes a unit there.
 */
export type ActiveCounts = { activeCap: number | null; liveCount: number; reservedCount: number };

/** A variant's active cap as the routes answer it. `remaining` is `null` with no cap. */
export type ActiveView = { cap: number | null; live: number; held: number; remaining: number | null; full: boolean };

/** Slots left. A cap lowered under the live count leaves 0: sales close, and no service ends (user, 2026-10-18). */
export function activeOf(v: ActiveCounts): ActiveView {
  const remaining = v.activeCap === null ? null : Math.max(0, v.activeCap - v.liveCount - v.reservedCount);
  return { cap: v.activeCap, live: v.liveCount, held: v.reservedCount, remaining, full: remaining === 0 };
}

/** What an offer shows: the smaller remainder of the two caps, and sold out when either is full (F-514). */
export function availabilityOf(v: SalesCounts & ActiveCounts): { remaining: number | null; soldOut: boolean } {
  const left = [salesOf(v).remaining, activeOf(v).remaining].filter((r): r is number => r !== null);
  const remaining = left.length === 0 ? null : Math.min(...left);
  return { remaining, soldOut: remaining === 0 };
}
