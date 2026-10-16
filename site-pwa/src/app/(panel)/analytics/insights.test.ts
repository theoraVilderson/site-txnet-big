import { describe, expect, it } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { OVERVIEW_KPIS, type AnalyticsInsight } from "@/lib/billing/analytics";
import { type InsightWords, KPI_LABEL, insightLines } from "./_lib/insights";

/**
 * The Overview's insights strip (F-1001-k, panel-web `contract.analytics.md`
 * "Overview" item 3) writes billing's `{key, params}` (F-1001-j) in the
 * reader's words. What goes wrong without anyone seeing it:
 *
 *  - **a sign in the sentence and a word for it too.** "down -12%" — the
 *    sentence carries the direction, the figure is its size;
 *  - **a line naming what the reader cannot open.** A product without an id
 *    has no filter to link to; a KPI billing adds later has no label yet, so it
 *    is left out rather than written as its key;
 *  - **a link that loses the view.** "See this day" is the current view cut
 *    to that day, built by the page's own `hrefOf`.
 */

const I = FrontendI18nKeys.common.analytics.insights;
const PRODUCT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const words: InsightWords = {
  t: (_ns: string, key: string, vars?: Record<string, string>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key),
  percent: (r: number) => `${Math.round(r * 100)}%`,
  money: (amount: string, currency: string) => `${amount} ${currency}`,
  formatDay: (day: string) => `on ${day}`,
  productName: (id: string | null) => (id === PRODUCT ? "Gold plan" : null),
  hrefOf: (patch) => `/analytics?${new URLSearchParams(Object.entries(patch).flatMap(([k, v]) => (v ? [[k, v]] : [])))}`,
};

describe("the insights strip", () => {
  it("writes a KPI move by its direction, the size without a sign, and labels every KPI billing answers", () => {
    const lines = insightLines(
      [
        { key: "kpiMove", params: { kpi: "refunds", delta: -0.125, currency: "USD" } },
        { key: "kpiMove", params: { kpi: "orders", delta: 0.4, currency: null } },
      ],
      words,
    );
    expect(lines.map((l) => [l.icon, l.text])).toEqual([
      ["down", `${I.kpiDown}:${I.kpis.refunds},13%`],
      ["up", `${I.kpiUp}:${I.kpis.orders},40%`],
    ]);
    expect(Object.keys(KPI_LABEL).sort()).toEqual([...OVERVIEW_KPIS].sort());
  });

  it("names the product, links to the page filtered to it, and leaves the link off a sale without a product", () => {
    const [named, bare] = insightLines(
      [
        { key: "productDrove", params: { productId: PRODUCT, change: "-40.00", currency: "USD" } },
        { key: "productDrove", params: { productId: null, change: "12.50", currency: "USD" } },
      ],
      words,
    );
    expect(named).toMatchObject({ icon: "down", text: `${I.productDown}:Gold plan,40.00 USD`, link: { href: `/analytics?product=${PRODUCT}`, label: I.showProduct } });
    expect(bare.link).toBeNull();
  });

  it("writes an unusual day high or low against its usual, linking to that day alone", () => {
    const [line] = insightLines([{ key: "unusualDay", params: { day: "2026-09-29", net: "5.00", mean: "10.00", currency: "USD" } }], words);
    expect(line).toMatchObject({ icon: "day", text: `${I.dayLow}:on 2026-09-29,5.00 USD,10.00 USD`, link: { href: "/analytics?range=custom&from=2026-09-29&to=2026-09-29", label: I.showDay } });
  });

  it("leaves out a line it has no words for — a KPI billing added after this panel", () => {
    const unknown = { key: "kpiMove", params: { kpi: "margin", delta: 0.2, currency: "USD" } } as AnalyticsInsight;
    expect(insightLines([unknown], words)).toEqual([]);
  });
});
