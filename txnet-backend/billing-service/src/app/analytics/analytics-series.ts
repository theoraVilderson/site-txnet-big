import { Prisma } from '@prisma/client';

import type { TabContext } from './analytics-context';
import type { Day } from './analytics-days';
import { Amounts, ByCurrency, amountsOf, hiddenKeys } from './analytics-figures';
import { DayMap, Window, readBuyers, readPayments, readSales } from './analytics-read';

/** One bucket's figures, per currency where they are money. */
type Bucket = { package: ByCurrency; usage: ByCurrency; topUps: ByCurrency; orders: number; buyers: number; newBuyers: number; currencies: Set<string> };

/** The series a chart draws, aligned with `buckets`; a bucket hidden from the platform's staff is `null` in every one. */
export type Series = {
  salesPackage: (Amounts | null)[];
  salesUsage: (Amounts | null)[];
  topUps: (Amounts | null)[];
  orders: (number | null)[];
  newBuyers: (number | null)[];
};

const add = (into: ByCurrency, code: string, v: Prisma.Decimal) => into.set(code, (into.get(code) ?? new Prisma.Decimal(0)).plus(v));

const empty = (): Bucket => ({ package: new Map(), usage: new Map(), topUps: new Map(), orders: 0, buyers: 0, newBuyers: 0, currencies: new Set() });

/** Every bucket's figures over `w`, cut by `map` — three reads, whatever the number of buckets. */
export async function bucketFigures(c: TabContext, w: Window, map: DayMap): Promise<Map<Day, Bucket>> {
  const sales = await readSales(c.tx, w, c.filters, ['bucket', 'kind'], map);
  const buyers = await readBuyers(c.tx, w, c.filters, ['bucket'], map);
  const payments = await readPayments(c.tx, w, ['bucket'], map);

  const out = new Map<Day, Bucket>();
  const at = (key: string | null) => {
    const k = key ?? '';
    let bucket = out.get(k);
    if (!bucket) out.set(k, (bucket = empty()));
    return bucket;
  };
  for (const r of sales) {
    const b = at(r.bucket);
    add(r.kind === 'package' ? b.package : b.usage, r.currencyCode, r.net);
    b.orders += r.orders;
    b.currencies.add(r.currencyCode);
  }
  for (const r of buyers) Object.assign(at(r.bucket), { buyers: r.buyers, newBuyers: r.newBuyers });
  for (const r of payments) {
    const b = at(r.bucket);
    add(b.topUps, r.currencyCode, r.settledAmount);
    b.currencies.add(r.currencyCode);
  }
  return out;
}

/** The buckets the platform's staff do not see (ADR-0104 (3)): judged on each bucket's buyers. */
export function hiddenBuckets(figures: Map<Day, Bucket>, hides: boolean): Set<Day> {
  const cells = [...figures].map(([key, b]) => ({ key, people: b.buyers, count: b.orders, currencies: b.currencies }));
  return hiddenKeys(cells, hides);
}

export function seriesOf(keys: readonly Day[], figures: Map<Day, Bucket>, currencies: readonly string[], hidden: ReadonlySet<Day>): Series {
  const each = <T>(pick: (b: Bucket) => T): (T | null)[] => keys.map((k) => (hidden.has(k) ? null : pick(figures.get(k) ?? empty())));
  return {
    salesPackage: each((b) => amountsOf(b.package, currencies)),
    salesUsage: each((b) => amountsOf(b.usage, currencies)),
    topUps: each((b) => amountsOf(b.topUps, currencies)),
    orders: each((b) => b.orders),
    newBuyers: each((b) => b.newBuyers),
  };
}

/** The current window's series and, when compared, the previous one's under the same keys. */
export async function seriesPair(c: TabContext, currencies: readonly string[]): Promise<{ series: Series; previousSeries: Series | null }> {
  const now = await bucketFigures(c, c.window, c.map);
  const before = c.previous && c.previousMap ? await bucketFigures(c, c.previous, c.previousMap) : null;
  return {
    series: seriesOf(c.buckets, now, currencies, hiddenBuckets(now, c.hides)),
    previousSeries: before ? seriesOf(c.buckets, before, currencies, hiddenBuckets(before, c.hides)) : null,
  };
}

