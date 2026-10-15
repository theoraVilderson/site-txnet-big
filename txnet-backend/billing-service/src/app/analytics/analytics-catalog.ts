import { Prisma } from '@prisma/client';

import { sparkPoints } from './analytics-buckets';
import type { TabContext } from './analytics-context';
import { dayMap } from './analytics-context';
import { Amounts, FEWER_THAN, amountsOf, byCurrency, currenciesOf, hiddenKeys } from './analytics-figures';
import { shareOf } from './analytics-overview';
import { readBuyers, readSales, readStock } from './analytics-read';

/** A catalog row's sparkline: the window in this many runs of whole days. */
const SPARK_POINTS = 12;

type CatalogCell =
  | { id: string | null; net: Amounts; orders: number; buyers: number; bytesSold: string; bytesUsed: string; share: number | null; sparkline: Amounts[] }
  | { id: string | null; people: typeof FEWER_THAN };

export type CatalogTab = { currencies: string[]; products: CatalogCell[]; panels: CatalogCell[] };

/**
 * Every product (or panel) with sales or traffic in the window: net, orders,
 * buyers, bytes sold and used, its share of the operating currency's net, and
 * a 12-point sparkline. Largest first; a cell under 5 people is hidden from the
 * platform's staff and listed last (ADR-0104 (3)).
 */
async function rowsBy(c: TabContext, split: 'product' | 'panel', currencies: readonly string[]): Promise<CatalogCell[]> {
  const idOf = (r: { productId: string | null; panelId: string | null }) => (split === 'product' ? r.productId : r.panelId);
  const points = sparkPoints(c.window.from, c.window.to, SPARK_POINTS);
  const sales = await readSales(c.tx, c.window, c.filters, [split]);
  const spark = await readSales(c.tx, c.window, c.filters, [split, 'bucket'], dayMap(c.window, points.keyOf));
  const buyers = new Map((await readBuyers(c.tx, c.window, c.filters, [split])).map((r) => [idOf(r), r.buyers]));
  const used = new Map((await readStock(c.tx, c.window, c.filters, [split])).map((r) => [idOf(r), r.bytesUsed]));

  const whole = byCurrency(sales, (r) => r.net).get(c.operating) ?? new Prisma.Decimal(0);
  const rows = [...new Set([...sales.map(idOf), ...used.keys()])].map((id) => {
    const own = sales.filter((r) => idOf(r) === id);
    return { id, own, net: byCurrency(own, (r) => r.net), orders: own.reduce((n, r) => n + r.orders, 0), people: buyers.get(id) ?? 0 };
  });
  const hidden = hiddenKeys(rows.map((r) => ({ key: r.id, people: r.people, count: r.orders, currencies: new Set(r.own.map((x) => x.currencyCode)) })), c.hides);
  const zero = new Prisma.Decimal(0);
  return [
    ...rows
      .filter((r) => !hidden.has(r.id))
      .sort((a, b) => (b.net.get(c.operating) ?? zero).comparedTo(a.net.get(c.operating) ?? zero) || b.orders - a.orders)
      .map((r) => ({
        id: r.id,
        net: amountsOf(r.net, currencies),
        orders: r.orders,
        buyers: r.people,
        bytesSold: r.own.reduce((n, x) => n + x.bytesSold, BigInt(0)).toString(),
        bytesUsed: (used.get(r.id) ?? BigInt(0)).toString(),
        share: shareOf(r.net.get(c.operating), whole),
        sparkline: points.keys.map((key) => amountsOf(byCurrency(spark.filter((x) => idOf(x) === r.id && x.bucket === key), (x) => x.net), currencies)),
      })),
    ...[...hidden].sort().map((id) => ({ id, people: FEWER_THAN })),
  ];
}

export async function catalogOf(c: TabContext): Promise<CatalogTab> {
  const sales = await readSales(c.tx, c.window, c.filters, []);
  const currencies = currenciesOf(c.operating, sales.map((r) => r.currencyCode));
  return { currencies, products: await rowsBy(c, 'product', currencies), panels: await rowsBy(c, 'panel', currencies) };
}
