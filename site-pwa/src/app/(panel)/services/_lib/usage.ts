import type { GrantUsage } from "@/lib/billing-api";

/**
 * The numbers behind the service page's ring and bars (F-307-c). Bytes arrive
 * as decimal strings because a Grant passes 2^53, so every ratio is taken in
 * `BigInt` and only the share — a number between 0 and 1 — becomes a float.
 */

// `BigInt(…)`, not literals: the panel targets below ES2020.
const ZERO = BigInt(0);
const SCALE = BigInt(1_000_000);

function big(bytes: string): bigint | null {
  try {
    return BigInt(bytes);
  } catch {
    return null;
  }
}

/** `part / whole` in [0, 1], exact to six places; `null` when `whole` is not positive. */
function share(part: bigint, whole: bigint): number | null {
  if (whole <= ZERO) return null;
  if (part <= ZERO) return 0;
  if (part >= whole) return 1;
  return Number((part * SCALE) / whole) / Number(SCALE);
}

/**
 * How much of what was bought is used, never past full; `null` when nothing
 * bounded was bought — a prepaid Grant, or a metered one before its first block.
 * A share below 1 never rounds up to 1: a Grant with a byte left is not full.
 */
export function usedShare(consumedBytes: string, purchasedBytes: string): number | null {
  const used = big(consumedBytes);
  const bought = big(purchasedBytes);
  if (used === null || bought === null) return null;
  const s = share(used, bought);
  return s === 1 && used < bought ? 0.999999 : s;
}

/** What is left of what was bought, as a decimal string; never negative. */
export function remainingBytes(consumedBytes: string, purchasedBytes: string): string {
  const used = big(consumedBytes) ?? ZERO;
  const bought = big(purchasedBytes) ?? ZERO;
  return (bought > used ? bought - used : ZERO).toString();
}

export interface DayBar {
  date: string;
  uploadBytes: string;
  downloadBytes: string;
  totalBytes: string;
  /** Against the busiest day of the window; 0 for a day with no traffic. */
  height: number;
  /** Of this day's bar, how much is download — the lower, stronger part. */
  downloadShare: number;
}

/** One bar per day billing answered, in its order, scaled to the busiest day. */
export function dayBars(days: GrantUsage["days"]): DayBar[] {
  const totals = days.map((d) => {
    const up = big(d.uploadBytes) ?? ZERO;
    const down = big(d.downloadBytes) ?? ZERO;
    return { d, up, down, total: up + down };
  });
  const max = totals.reduce((m, x) => (x.total > m ? x.total : m), ZERO);
  return totals.map(({ d, down, total }) => ({
    date: d.date,
    uploadBytes: d.uploadBytes,
    downloadBytes: d.downloadBytes,
    totalBytes: total.toString(),
    height: share(total, max) ?? 0,
    downloadShare: share(down, total) ?? 0,
  }));
}

/** The window's whole traffic, as a decimal string. */
export function windowTotal(bars: DayBar[]): string {
  return bars.reduce((sum, b) => sum + BigInt(b.totalBytes), ZERO).toString();
}
