import type { Prisma } from '@prisma/client';
import type { CurrencyPlaces } from '@txnet-backend/shared-core';

import { Calendar, Granularity, bucketsOf, granularityFor, previousRange } from './analytics-buckets';
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
  /** The calendar weeks and months are cut in (F-1004-a: a cohort is a month of it). */
  calendar: Calendar;
  buckets: Day[];
  map: DayMap;
  previousMap: DayMap | null;
  /** The tenant's operating currency now: listed first, and what a share is a share of. */
  operating: string;
  /** The platform's staff reading a reseller: cells under 5 people are hidden (ADR-0104 (3)). */
  hides: boolean;
  /** Every tenant's rollup, for the platform's own `resellers` and `margin` tabs (F-1001-h, F-1001-l); absent on every other read. */
  across?: CrossTenantReader;
  /** The tenant read is the platform's own (F-1001-l: its panels' "no cost set"). */
  platform: boolean;
  /** Each currency's places: an average or a forecast is rounded there before it is answered (ADR-0153). */
  places: CurrencyPlaces;
};

/** What the `resellers` tab reads every reseller's rollup through: the cross-tenant pool, raw SQL only. */
export type CrossTenantReader = Pick<Prisma.TransactionClient, '$queryRaw'>;

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

export function contextOf(tx: Prisma.TransactionClient, q: AnalyticsQuery, how: { operating: string; hides: boolean; places: CurrencyPlaces; across?: CrossTenantReader; platform?: boolean }): TabContext {
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
    calendar: q.calendar,
    buckets: current.keys,
    map: dayMap(window, current.keyOf),
    previousMap,
    operating: how.operating,
    hides: how.hides,
    across: how.across,
    platform: how.platform === true,
    places: how.places,
  };
}
