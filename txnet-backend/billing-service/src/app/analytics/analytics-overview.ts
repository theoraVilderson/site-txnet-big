import { Prisma } from '@prisma/client';

import type { TabContext } from './analytics-context';
import { dayMap } from './analytics-context';
import { Day, addDays } from './analytics-days';
import {
  Amounts,
  CountKpi,
  Delta,
  FEWER_THAN,
  MoneyKpi,
  amountsOf,
  byCurrency,
  countKpi,
  currenciesOf,
  deltaOf,
  hiddenKeys,
  moneyKpi,
  perUnit,
} from './analytics-figures';
import { RenewalFigures, renewalFiguresOf } from './analytics-customers';
import { Insight, insightsOf } from './analytics-insights';
import { readBuyers, readSales } from './analytics-read';
import { Series, seriesPair } from './analytics-series';
import { Totals, totalsPair } from './analytics-totals';
import { UsageCard, usageOf } from './analytics-usage';

/** The overview's product list: this many, then everything else as one `other`. */
const TOP_PRODUCTS = 7;
/** The calendar heatmap's reach, ending on the window's last day. */
const CALENDAR_DAYS = 365;

/** A product row, or one hidden from the platform's staff — its id and nothing else. */
type ProductCell = { productId: string | null; net: Amounts; orders: number; buyers: number; share: number | null } | { productId: string | null; people: typeof FEWER_THAN };

export type Overview = {
  currencies: string[];
  kpis: {
    net: MoneyKpi;
    gross: MoneyKpi;
    refunds: MoneyKpi;
    topUps: MoneyKpi;
    aov: MoneyKpi;
    arpu: MoneyKpi;
    orders: CountKpi;
    buyers: CountKpi;
    newBuyers: CountKpi;
    returningBuyers: CountKpi;
    /** Terms that ended in the window and where they stand (F-1001-f). */
    renewal: RenewalFigures;
    activeGrants: CountKpi;
    bytesUsed: { value: string; previous: string | null; delta: Delta };
  };
  series: Series;
  previousSeries: Series | null;
  byProduct: { top: ProductCell[]; other: { net: Amounts; orders: number; share: number | null } | null };
  calendar: { day: Day; net: Amounts | null }[];
  /** Up to three "what changed" lines (F-1001-j). */
  insights: Insight[];
  /** One card per meter used in either window, in its own unit (F-1001-n, ADR-0148). */
  usage: UsageCard[];
};

function kpisOf(now: Totals, before: Totals | null, currencies: readonly string[], renewal: RenewalFigures): Overview['kpis'] {
  const money = (pick: (t: Totals) => Totals['net']) => moneyKpi(pick(now), before ? pick(before) : null, currencies);
  const count = (pick: (t: Totals) => number) => countKpi(pick(now), before ? pick(before) : null);
  return {
    net: money((t) => t.net),
    gross: money((t) => t.gross),
    refunds: money((t) => t.refunds),
    topUps: money((t) => t.topUps),
    aov: money((t) => perUnit(t.net, t.orders)),
    arpu: money((t) => perUnit(t.net, t.buyers)),
    orders: count((t) => t.orders),
    buyers: count((t) => t.buyers),
    newBuyers: count((t) => t.newBuyers),
    returningBuyers: count((t) => t.buyers - t.newBuyers),
    renewal,
    activeGrants: count((t) => t.activeGrants),
    bytesUsed: { value: now.bytesUsed.toString(), previous: before?.bytesUsed.toString() ?? null, delta: before ? deltaOf(now.bytesUsed.toString(), before.bytesUsed.toString()) : null },
  };
}

/** A part of the operating currency's whole, as a ratio; none when the whole is zero. */
export function shareOf(part: Prisma.Decimal | undefined, whole: Prisma.Decimal): number | null {
  return whole.isZero() ? null : (part ?? new Prisma.Decimal(0)).div(whole).toDecimalPlaces(4).toNumber();
}

/** Sales by product, largest first in the operating currency: the top seven and the rest as `other`. */
async function byProductOf(c: TabContext, currencies: readonly string[]): Promise<Overview['byProduct']> {
  const sales = await readSales(c.tx, c.window, c.filters, ['product']);
  const buyers = new Map((await readBuyers(c.tx, c.window, c.filters, ['product'])).map((r) => [r.productId, r.buyers]));
  const ids = [...new Set(sales.map((r) => r.productId))];
  const rows = ids.map((productId) => {
    const own = sales.filter((r) => r.productId === productId);
    return { productId, net: byCurrency(own, (r) => r.net), orders: own.reduce((n, r) => n + r.orders, 0), buyers: buyers.get(productId) ?? 0, currencies: new Set(own.map((r) => r.currencyCode)) };
  });
  const hidden = hiddenKeys(rows.map((r) => ({ key: r.productId, people: r.buyers, count: r.orders, currencies: r.currencies })), c.hides);
  const whole = byCurrency(sales, (r) => r.net).get(c.operating) ?? new Prisma.Decimal(0);
  const shown = rows
    .filter((r) => !hidden.has(r.productId))
    .sort((a, b) => (b.net.get(c.operating) ?? new Prisma.Decimal(0)).comparedTo(a.net.get(c.operating) ?? new Prisma.Decimal(0)) || b.orders - a.orders);
  const cell = (r: (typeof rows)[number]): ProductCell => ({ productId: r.productId, net: amountsOf(r.net, currencies), orders: r.orders, buyers: r.buyers, share: shareOf(r.net.get(c.operating), whole) });
  const rest = shown.slice(TOP_PRODUCTS);
  const restNet = new Map(currencies.map((code) => [code, rest.reduce((sum, r) => sum.plus(r.net.get(code) ?? 0), new Prisma.Decimal(0))]));
  return {
    // Hidden cells come last, in id order, so where one sits says nothing about its size.
    top: [...shown.slice(0, TOP_PRODUCTS).map(cell), ...[...hidden].sort().map((productId) => ({ productId, people: FEWER_THAN }))],
    other: rest.length ? { net: amountsOf(restNet, currencies), orders: rest.reduce((n, r) => n + r.orders, 0), share: shareOf(restNet.get(c.operating), whole) } : null,
  };
}

/** Net sales per day over the last year to the window's end — the "when do we sell" picture. */
async function calendarOf(c: TabContext, currencies: readonly string[]): Promise<Overview['calendar']> {
  const w = { from: addDays(c.window.to, 1 - CALENDAR_DAYS), to: c.window.to };
  const map = dayMap(w, (day) => day);
  const sales = await readSales(c.tx, w, c.filters, ['bucket'], map);
  const people = await readBuyers(c.tx, w, c.filters, ['bucket'], map);
  const cells = people.map((p) => {
    const own = sales.filter((r) => r.bucket === p.bucket);
    return { key: p.bucket ?? '', people: p.buyers, count: own.reduce((n, r) => n + r.orders, 0), currencies: new Set(own.map((r) => r.currencyCode)) };
  });
  const hidden = hiddenKeys(cells, c.hides);
  return map.days.map((day) => ({ day, net: hidden.has(day) ? null : amountsOf(byCurrency(sales.filter((r) => r.bucket === day), (r) => r.net), currencies) }));
}

export async function overviewOf(c: TabContext): Promise<Overview> {
  const { now, before } = await totalsPair(c);
  const currencies = currenciesOf(c.operating, now.currencies, before?.currencies ?? []);
  const kpis = kpisOf(now, before, currencies, await renewalFiguresOf(c));
  const series = await seriesPair(c, currencies);
  // The buckets the series hide from the platform's staff hide usage too.
  const hidden = new Set(c.buckets.filter((_, i) => series.series.orders[i] === null));
  return {
    currencies,
    kpis,
    ...series,
    byProduct: await byProductOf(c, currencies),
    calendar: await calendarOf(c, currencies),
    // A rate with no previous window is no KPI move: renewal is not one of the lines.
    insights: await insightsOf(c, { ...kpis, renewal: null }),
    usage: await usageOf(c, hidden),
  };
}
