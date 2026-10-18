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
