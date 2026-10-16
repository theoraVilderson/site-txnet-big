import type { Prisma } from '@prisma/client';

import { Granularity, bucketsOf, granularityFor, previousRange } from './analytics-buckets';
import { Day, addDays } from './analytics-days';
import type { AnalyticsFilters, DayMap, Window } from './analytics-read';
import type { AnalyticsQuery } from './analytics.schema';

/**
 * Everything one tab read needs, resolved once: the window and the one it is
 * compared with, the buckets the server chose, and the day maps that cut both
 * into the **same** keys — the previous window's i-th bucket is answered under
 * the current one's i-th key, so `previousSeries` aligns by index.
 */
export type TabContext = {
  tx: Prisma.TransactionClient;
  window: Window;
  previous: Window | null;
  filters: AnalyticsFilters;
  granularity: Granularity;
  buckets: Day[];
  map: DayMap;
  previousMap: DayMap | null;
  /** The tenant's operating currency now: listed first, and what a share is a share of. */
  operating: string;
  /** The platform's staff reading a reseller: cells under 5 people are hidden (ADR-0104 (3)). */
  hides: boolean;
};

/** Every day of `w` paired with `keyOf(day)`; a day `keyOf` drops is left out. */
export function dayMap(w: Window, keyOf: (day: Day) => Day | undefined): DayMap {
  const map: DayMap = { days: [], keys: [] };
  for (let day = w.from; day <= w.to; day = addDays(day, 1)) {
    const key = keyOf(day);
    if (key === undefined) continue;
    map.days.push(day);
    map.keys.push(key);
  }
  return map;
}

export function contextOf(tx: Prisma.TransactionClient, q: AnalyticsQuery, how: { operating: string; hides: boolean }): TabContext {
  const window = { from: q.from, to: q.to };
  const granularity = granularityFor(q.from, q.to);
  const current = bucketsOf(q.from, q.to, granularity, q.calendar);
  const previous = previousRange(q.from, q.to, q.compare);

  let previousMap: DayMap | null = null;
  if (previous) {
    // The previous window cut its own way, each of its buckets renamed to the current bucket at the same index.
    const before = bucketsOf(previous.from, previous.to, granularity, q.calendar);
    const rename = new Map(before.keys.map((key, i) => [key, current.keys[i]]));
    previousMap = dayMap(previous, (day) => rename.get(before.keyOf(day)));
  }

  return {
    tx,
    window,
    previous,
    filters: { product: q.product, panel: q.panel, kind: q.kind, fulfilment: q.fulfilment },
    granularity,
    buckets: current.keys,
    map: dayMap(window, current.keyOf),
    previousMap,
    operating: how.operating,
    hides: how.hides,
  };
}
