import { Prisma } from '@prisma/client';
import { moneyText, roundConverted } from '@txnet-backend/shared-core';

import type { TabContext } from './analytics-context';
import { dayMap } from './analytics-context';
import { Day, addDays } from './analytics-days';
import { CountKpi, MoneyKpi, hiddenKeys } from './analytics-figures';
import { Window, readBuyers, readSales } from './analytics-read';

/**
 * The overview's "what changed" lines (F-1001-j, billing/contract.analytics.md
 * "Insights"): up to three, each a `key` naming the sentence and the figures it
 * is written from. The words are the panel's locale — no language model, and
 * no text in this service (C-19). A rule with nothing to say says nothing.
 */
export type Insight =
  | { key: 'kpiMove'; params: { kpi: string; delta: number; currency: string | null } }
  | { key: 'productDrove'; params: { productId: string | null; change: string; currency: string } }
  | { key: 'unusualDay'; params: { day: Day; net: string; mean: string; currency: string } };

/** A day is unusual past this many standard deviations from its own previous days. */
const UNUSUAL_SIGMAS = 2;
/** How many previous days a day is judged against. */
export const BASELINE_DAYS = 28;

const ZERO = new Prisma.Decimal(0);

type Kpi = MoneyKpi | CountKpi | { delta: CountKpi['delta'] };

/**
 * The KPI with the largest absolute delta — money in the operating currency.
 * `new` (a rise from zero) is no ratio, so it never competes; ties go to the
 * KPI listed first, which is net.
 */
export function kpiInsight(kpis: Record<string, Kpi | null>, operating: string): Insight | null {
  let best: { kpi: string; delta: number; currency: string | null } | null = null;
  for (const [kpi, figure] of Object.entries(kpis)) {
    if (!figure) continue;
    const money = typeof figure.delta === 'object' && figure.delta !== null;
    const delta = typeof figure.delta === 'object' && figure.delta !== null ? figure.delta[operating] : figure.delta;
    if (typeof delta !== 'number' || delta === 0) continue;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { kpi, delta, currency: money ? operating : null };
  }
  return best && { key: 'kpiMove', params: best };
}

/**
 * The product that moved net most in the direction net moved — a large one
 * that fell is not why net rose. A product hidden from the platform's staff in
 * either window is never named (ADR-0104 (3)); the total it is judged against
 * is the whole tenant's, which is tier A.
 */
export function productInsight(
  now: ReadonlyMap<string | null, Prisma.Decimal>,
  before: ReadonlyMap<string | null, Prisma.Decimal> | null,
  hidden: ReadonlySet<string | null>,
  operating: string,
): Insight | null {
  if (!before) return null;
  const ids = new Set([...now.keys(), ...before.keys()]);
  const change = (id: string | null) => (now.get(id) ?? ZERO).minus(before.get(id) ?? ZERO);
  const total = [...ids].reduce((sum, id) => sum.plus(change(id)), ZERO);
  if (total.isZero()) return null;
  let best: { productId: string | null; change: Prisma.Decimal } | null = null;
  for (const id of ids) {
    const c = change(id);
    if (hidden.has(id) || c.isZero() || c.isNegative() !== total.isNegative()) continue;
    if (!best || c.abs().greaterThan(best.change.abs())) best = { productId: id, change: c };
  }
  return best && { key: 'productDrove', params: { productId: best.productId, change: moneyText(best.change), currency: operating } };
}

/**
 * The window day furthest past 2σ of its own previous 28 days. `days` is every
 * day in order, the first `windowStart` of them the baseline before the window.
 * A flat baseline (σ 0) judges nothing: a first sale after quiet weeks is not
 * news worth a line.
 */
export function unusualDayInsight(days: readonly { day: Day; net: Prisma.Decimal }[], windowStart: number, operating: { code: string; places: number }): Insight | null {
  let best: { day: Day; net: Prisma.Decimal; mean: Prisma.Decimal; z: Prisma.Decimal } | null = null;
  for (let i = Math.max(windowStart, BASELINE_DAYS); i < days.length; i++) {
    const base = days.slice(i - BASELINE_DAYS, i).map((x) => x.net);
    const mean = base.reduce((s, v) => s.plus(v), ZERO).div(BASELINE_DAYS);
    const sigma = base.reduce((s, v) => s.plus(v.minus(mean).pow(2)), ZERO).div(BASELINE_DAYS).sqrt();
    if (sigma.isZero()) continue;
    const z = days[i].net.minus(mean).div(sigma).abs();
    if (z.greaterThan(UNUSUAL_SIGMAS) && (!best || z.greaterThan(best.z))) best = { day: days[i].day, net: days[i].net, mean, z };
  }
  return best && { key: 'unusualDay', params: { day: best.day, net: moneyText(best.net), mean: moneyText(roundConverted(best.mean, operating.places)), currency: operating.code } };
}

/** Net per product in the operating currency, and the products the platform's staff may not see. */
async function productNet(c: TabContext, w: Window): Promise<{ net: Map<string | null, Prisma.Decimal>; hidden: Set<string | null> }> {
  const sales = await readSales(c.tx, w, c.filters, ['product']);
  const net = new Map<string | null, Prisma.Decimal>();
  for (const r of sales) if (r.currencyCode === c.operating) net.set(r.productId, (net.get(r.productId) ?? ZERO).plus(r.net));
  if (!c.hides) return { net, hidden: new Set() };
  const buyers = new Map((await readBuyers(c.tx, w, c.filters, ['product'])).map((r) => [r.productId, r.buyers]));
  const ids = [...new Set(sales.map((r) => r.productId))];
  const cells = ids.map((id) => {
    const own = sales.filter((r) => r.productId === id);
    return { key: id, people: buyers.get(id) ?? 0, count: own.reduce((n, r) => n + r.orders, 0), currencies: new Set(own.map((r) => r.currencyCode)) };
  });
  return { net, hidden: hiddenKeys(cells, true) };
}

/** Net per day over the window and the 28 days before it, a day without sales at zero. */
async function dailyNet(c: TabContext): Promise<{ day: Day; net: Prisma.Decimal }[]> {
  const w = { from: addDays(c.window.from, -BASELINE_DAYS), to: c.window.to };
  const map = dayMap(w, (day) => day);
  const sales = await readSales(c.tx, w, c.filters, ['bucket'], map);
  const net = new Map(sales.filter((r) => r.currencyCode === c.operating).map((r) => [r.bucket, r.net]));
  return map.days.map((day) => ({ day, net: net.get(day) ?? ZERO }));
}

/**
 * The three rules in order. With a product filter on, the product rule would
 * only restate net, so it is left out. To the platform's staff on a reseller
 * the day rule says nothing: a day's figure and its 28-day mean together can
 * describe a cell the calendar hides.
 */
export async function insightsOf(c: TabContext, kpis: Record<string, Kpi | null>): Promise<Insight[]> {
  const out = [kpiInsight(kpis, c.operating)];
  if (!c.filters.product && c.previous) {
    const now = await productNet(c, c.window);
    const before = await productNet(c, c.previous);
    out.push(productInsight(now.net, before.net, new Set([...now.hidden, ...before.hidden]), c.operating));
  }
  if (!c.hides) out.push(unusualDayInsight(await dailyNet(c), BASELINE_DAYS, { code: c.operating, places: c.places.of(c.operating) }));
  return out.filter((i): i is Insight => i !== null);
}
