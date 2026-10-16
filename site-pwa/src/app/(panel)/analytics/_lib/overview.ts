import type { Amounts, AnalyticsNames, AnalyticsOverview, AnalyticsSeries, Delta } from "@/lib/billing/analytics";

/**
 * The Overview's figures as the charts draw them (F-1001-d, panel-web
 * `contract.analytics.md` "Overview"). Billing answers money per currency as
 * decimal strings; a chart needs a number to place a mark, so the drawing is a
 * number while every label is written from the currency's own format. A sum
 * never crosses currencies (billing principle 6): each figure is one currency's.
 */

/** What the hero can show — one chart, one axis (rule 1). */
export const HERO_METRICS = ["net", "topUps", "orders", "newBuyers"] as const;
export type HeroMetric = (typeof HERO_METRICS)[number];

/** Which hero metrics are money; the rest are counts. */
export const MONEY_METRICS: ReadonlySet<HeroMetric> = new Set(["net", "topUps"]);

/** One currency's amount as a number to draw; a hidden or absent figure is null, never zero. */
export const amountIn = (amounts: Amounts | null | undefined, currency: string): number | null => {
  const v = amounts?.[currency];
  return v === undefined ? null : Number(v);
};

const sum = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

/** The hero's series for a metric: net is package + usage sales, per bucket (billing "Read routes"). */
export function heroSeries(series: AnalyticsSeries, metric: HeroMetric, currency: string): (number | null)[] {
  switch (metric) {
    case "net":
      return series.salesPackage.map((p, i) => sum(amountIn(p, currency), amountIn(series.salesUsage[i], currency)));
    case "topUps":
      return series.topUps.map((v) => amountIn(v, currency));
    case "orders":
      return series.orders;
    case "newBuyers":
      return series.newBuyers;
  }
}

/** The hero's headline figure and its change against the compared window. */
export function heroFigure(kpis: AnalyticsOverview["kpis"], metric: HeroMetric, currency: string): { value: number; delta: Delta } {
  if (metric === "net" || metric === "topUps") return { value: amountIn(kpis[metric].value, currency) ?? 0, delta: kpis[metric].delta[currency] ?? null };
  return { value: kpis[metric].value, delta: kpis[metric].delta };
}

/** The currency to draw: the URL's when the answer has it, else the operating one (listed first). */
export function currencyOf(currencies: readonly string[], wanted: string | null): string | null {
  return wanted && currencies.includes(wanted) ? wanted : (currencies[0] ?? null);
}

/** A product's id -> its words in the reader's language; the key itself never reaches the page. */
export function productNamer(names: AnalyticsNames, texts: Record<string, string>): (id: string | null) => string | null {
  const keys = new Map(names.products.map((p) => [p.id, p.nameKey]));
  return (id) => {
    const key = id ? keys.get(id) : undefined;
    return key ? (texts[key] ?? null) : null;
  };
}

/** The catalog's order of the products, which gives each its colour slot (rule 3). */
export const catalogOrder = (names: AnalyticsNames): string[] => names.products.map((p) => p.id);
