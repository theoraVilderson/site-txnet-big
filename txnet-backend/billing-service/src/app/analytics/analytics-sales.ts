import type { TabContext } from './analytics-context';
import { Amounts, FEWER_THAN, MoneyKpi, amountsOf, byCurrency, currenciesOf, hiddenKeys, moneyKpi } from './analytics-figures';
import { readBuyers, readPayments, readSales } from './analytics-read';
import { Series, seriesPair } from './analytics-series';
import { totalsPair } from './analytics-totals';

type GatewayCell = { gatewayKind: string | null; started: number; settled: number; failed: number; successRate: number | null; settledAmount: Amounts };

export type SalesTab = {
  currencies: string[];
  series: Series;
  previousSeries: Series | null;
  /**
   * Top-ups by gateway kind. `byKind` is `null` to the platform's staff
   * reading a reseller: the rollup holds no payer per gateway, so no cell could
   * be judged on its people (ADR-0104 (3)) — the totals stand.
   */
  payments: { started: number; settled: number; failed: number; successRate: number | null; byKind: GatewayCell[] | null };
  refunds: MoneyKpi;
  discounts: MoneyKpi;
  giftsCredited: MoneyKpi;
  refundsByProduct: ({ productId: string | null; refunds: Amounts } | { productId: string | null; people: typeof FEWER_THAN })[];
};

/** Settled ÷ started, to four places; none before anything started. */
const rateOf = (settled: number, started: number) => (started > 0 ? Math.round((settled / started) * 10_000) / 10_000 : null);

async function paymentsOf(c: TabContext, currencies: readonly string[]): Promise<SalesTab['payments']> {
  // A gift credit is under a null kind and started nothing: it is the gifts figure, not a gateway.
  const rows = (await readPayments(c.tx, c.window, ['gatewayKind'])).filter((r) => r.gatewayKind !== null);
  const kinds = [...new Set(rows.map((r) => r.gatewayKind))].sort();
  const byKind = kinds.map((gatewayKind): GatewayCell => {
    const own = rows.filter((r) => r.gatewayKind === gatewayKind);
    const [started, settled, failed] = (['started', 'settled', 'failed'] as const).map((k) => own.reduce((n, r) => n + r[k], 0));
    return { gatewayKind, started, settled, failed, successRate: rateOf(settled, started), settledAmount: amountsOf(byCurrency(own, (r) => r.settledAmount), currencies) };
  });
  const sum = (k: 'started' | 'settled' | 'failed') => byKind.reduce((n, g) => n + g[k], 0);
  return { started: sum('started'), settled: sum('settled'), failed: sum('failed'), successRate: rateOf(sum('settled'), sum('started')), byKind: c.hides ? null : byKind };
}

async function refundsByProductOf(c: TabContext, currencies: readonly string[]): Promise<SalesTab['refundsByProduct']> {
  const sales = (await readSales(c.tx, c.window, c.filters, ['product'])).filter((r) => !r.refunds.isZero());
  const buyers = new Map((await readBuyers(c.tx, c.window, c.filters, ['product'])).map((r) => [r.productId, r.buyers]));
  const ids = [...new Set(sales.map((r) => r.productId))];
  const cells = ids.map((productId) => {
    const own = sales.filter((r) => r.productId === productId);
    return { key: productId, people: buyers.get(productId) ?? 0, count: own.reduce((n, r) => n + r.orders, 0), currencies: new Set(own.map((r) => r.currencyCode)), refunds: byCurrency(own, (r) => r.refunds) };
  });
  const hidden = hiddenKeys(cells, c.hides);
  return [
    ...cells.filter((x) => !hidden.has(x.key)).map((x) => ({ productId: x.key, refunds: amountsOf(x.refunds, currencies) })),
    ...[...hidden].sort().map((productId) => ({ productId, people: FEWER_THAN })),
  ];
}

export async function salesOf(c: TabContext): Promise<SalesTab> {
  const { now, before } = await totalsPair(c);
  const currencies = currenciesOf(c.operating, now.currencies, before?.currencies ?? []);
  return {
    currencies,
    ...(await seriesPair(c, currencies)),
    payments: await paymentsOf(c, currencies),
    refunds: moneyKpi(now.refunds, before?.refunds ?? null, currencies),
    discounts: moneyKpi(now.discounts, before?.discounts ?? null, currencies),
    giftsCredited: moneyKpi(now.giftsCredited, before?.giftsCredited ?? null, currencies),
    refundsByProduct: await refundsByProductOf(c, currencies),
  };
}
