import type { TabContext } from './analytics-context';
import { ByCurrency, byCurrency } from './analytics-figures';
import { Window, readBuyers, readPayments, readSales, readStock } from './analytics-read';

/** One window's whole figures — never suppressed: totals for the whole tenant are tier A (ADR-0104 (3)). */
export type Totals = {
  gross: ByCurrency;
  refunds: ByCurrency;
  net: ByCurrency;
  discounts: ByCurrency;
  topUps: ByCurrency;
  giftsCredited: ByCurrency;
  orders: number;
  buyers: number;
  newBuyers: number;
  /** Services standing at the window's last snapshot (a stock, never summed over days). */
  activeGrants: number;
  bytesUsed: bigint;
  /** Every currency any figure above holds. */
  currencies: Set<string>;
};

export async function totalsOf(c: TabContext, w: Window): Promise<Totals> {
  const sales = await readSales(c.tx, w, c.filters, []);
  const [buyers] = await readBuyers(c.tx, w, c.filters, []);
  const payments = await readPayments(c.tx, w, []);
  const [stock] = await readStock(c.tx, w, c.filters, []);
  return {
    gross: byCurrency(sales, (r) => r.gross),
    refunds: byCurrency(sales, (r) => r.refunds),
    net: byCurrency(sales, (r) => r.net),
    discounts: byCurrency(sales, (r) => r.discounts),
    topUps: byCurrency(payments, (r) => r.settledAmount),
    giftsCredited: byCurrency(payments, (r) => r.giftsCredited),
    orders: sales.reduce((n, r) => n + r.orders, 0),
    buyers: buyers?.buyers ?? 0,
    newBuyers: buyers?.newBuyers ?? 0,
    activeGrants: stock?.activeGrants ?? 0,
    bytesUsed: stock?.bytesUsed ?? BigInt(0),
    currencies: new Set([...sales, ...payments].map((r) => r.currencyCode)),
  };
}

/** The current window's totals, and the compared window's when there is one. */
export async function totalsPair(c: TabContext): Promise<{ now: Totals; before: Totals | null }> {
  const now = await totalsOf(c, c.window);
  return { now, before: c.previous ? await totalsOf(c, c.previous) : null };
}
