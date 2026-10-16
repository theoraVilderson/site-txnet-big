import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AnalyticsInsight, OverviewKpi } from "@/lib/billing/analytics";
import type { AnalyticsFilters } from "./filters";

/**
 * The Overview's insights strip (F-1001-k, panel-web `contract.analytics.md`
 * "Overview" item 3): billing's `{key, params}` lines (F-1001-j) in the
 * reader's words. The sentence carries the direction, so every figure in it is
 * a size, never signed.
 */

const I = FrontendI18nKeys.common.analytics.insights;

/** Every KPI an insight may name, by its label. */
export const KPI_LABEL: Record<OverviewKpi, string> = {
  net: I.kpis.net,
  gross: I.kpis.gross,
  refunds: I.kpis.refunds,
  topUps: I.kpis.topUps,
  aov: I.kpis.aov,
  arpu: I.kpis.arpu,
  orders: I.kpis.orders,
  buyers: I.kpis.buyers,
  newBuyers: I.kpis.newBuyers,
  returningBuyers: I.kpis.returningBuyers,
  activeGrants: I.kpis.activeGrants,
  bytesUsed: I.kpis.bytesUsed,
};

const isKpi = (k: string): k is OverviewKpi => Object.hasOwn(KPI_LABEL, k);

export type InsightIcon = "up" | "down" | "day";

export interface InsightLine {
  id: string;
  icon: InsightIcon;
  text: string;
  /** Where the line is explained; none when there is nothing to open. */
  link: { href: string; label: string } | null;
}

/** What the page writes a line with — its own formats and its own links. */
export interface InsightWords {
  t: (ns: "common", key: string, vars?: Record<string, string>) => string;
  percent: (ratio: number) => string;
  money: (amount: string, currency: string) => string;
  formatDay: (day: string) => string;
  productName: (id: string | null) => string | null;
  hrefOf: (patch: Partial<AnalyticsFilters>) => string;
}

const unsigned = (amount: string) => amount.replace(/^-/, "");
const fell = (amount: string) => amount.startsWith("-");

function lineOf(
  insight: AnalyticsInsight,
  w: InsightWords,
): Omit<InsightLine, "id"> | null {
  switch (insight.key) {
    case "kpiMove": {
      const { kpi, delta } = insight.params;
      if (!isKpi(kpi)) return null;
      const down = delta < 0;
      return {
        icon: down ? "down" : "up",
        text: w.t("common", down ? I.kpiDown : I.kpiUp, {
          kpi: w.t("common", KPI_LABEL[kpi]),
          delta: w.percent(Math.abs(delta)),
        }),
        link: null,
      };
    }
    case "productDrove": {
      const { productId, change, currency } = insight.params;
      const down = fell(change);
      const product =
        w.productName(productId) ??
        w.t("common", FrontendI18nKeys.common.analytics.byProduct.unnamed);
      return {
        icon: down ? "down" : "up",
        text: w.t("common", down ? I.productDown : I.productUp, {
          product,
          change: w.money(unsigned(change), currency),
        }),
        link: productId
          ? {
              href: w.hrefOf({ product: productId }),
              label: w.t("common", I.showProduct),
            }
          : null,
      };
    }
    case "unusualDay": {
      const { day, net, mean, currency } = insight.params;
      const low = Number(net) < Number(mean);
      return {
        icon: "day",
        text: w.t("common", low ? I.dayLow : I.dayHigh, {
          day: w.formatDay(day),
          net: w.money(net, currency),
          mean: w.money(mean, currency),
        }),
        link: {
          href: w.hrefOf({ range: "custom", from: day, to: day }),
          label: w.t("common", I.showDay),
        },
      };
    }
    default:
      // A sentence billing added after this panel was built has no words here yet.
      return null;
  }
}

/** Billing's lines in its order; one this panel has no words for is left out, never shown as its key. */
export function insightLines(
  insights: readonly AnalyticsInsight[],
  w: InsightWords,
): InsightLine[] {
  return insights.flatMap((insight, i) => {
    const line = lineOf(insight, w);
    return line ? [{ id: `${insight.key}-${i}`, ...line }] : [];
  });
}
