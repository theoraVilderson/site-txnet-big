import type { TabContext } from './analytics-context';
import type { Day } from './analytics-days';
import { Delta, deltaOf } from './analytics-figures';
import { MeterRow, readMeters } from './analytics-read';

/**
 * Usage per meter (F-1001-n, ADR-0148): one card per meter used in either
 * window, each in that meter's own unit — bytes, counts, seconds and tokens
 * are never added together. Quantities are integers as decimal strings (a
 * byte total outgrows a JS number).
 */
export type UsageCard = {
  meterKey: string;
  total: string;
  previous: string | null;
  delta: Delta;
  /** Aligned with the answer's `buckets`; a bucket hidden from the platform's staff is null. */
  series: (string | null)[];
};

const sum = (rows: readonly MeterRow[]) => rows.reduce((n, r) => n + r.quantity, BigInt(0));

/** The cards from each window's rows by meter and bucket; `before` is null with nothing compared. */
export function usageCards(now: readonly MeterRow[], before: readonly MeterRow[] | null, buckets: readonly Day[], hidden: ReadonlySet<Day>): UsageCard[] {
  const keys = [...new Set([...now, ...(before ?? [])].map((r) => r.meterKey))].sort();
  return keys.map((meterKey) => {
    const own = now.filter((r) => r.meterKey === meterKey);
    const total = sum(own).toString();
    const previous = before ? sum(before.filter((r) => r.meterKey === meterKey)).toString() : null;
    return {
      meterKey,
      total,
      previous,
      delta: deltaOf(total, previous),
      series: buckets.map((b) => (hidden.has(b) ? null : sum(own.filter((r) => r.bucket === b)).toString())),
    };
  });
}

/**
 * The overview's usage. `hidden` is the buckets the overview's series already
 * hide from the platform's staff — usage is cut by the same buckets, so the
 * same ones are hidden, judged once on their buyers.
 */
export async function usageOf(c: TabContext, hidden: ReadonlySet<Day>): Promise<UsageCard[]> {
  const now = await readMeters(c.tx, c.window, c.filters, ['bucket'], c.map);
  const before = c.previous && c.previousMap ? await readMeters(c.tx, c.previous, c.filters, ['bucket'], c.previousMap) : null;
  return usageCards(now, before, c.buckets, hidden);
}
