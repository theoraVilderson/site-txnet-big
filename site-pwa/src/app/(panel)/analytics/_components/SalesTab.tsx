"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { type AnalyticsSales, FEWER_THAN_5 } from "@/lib/billing/analytics";
import { formatMoney } from "../../_lib/money";
import { BarList, ChartCard, Meter, StackedColumns, StatTile, TrendChart, slotColor, useChartFormat } from "../../_components/kit/charts";
import { amountIn, heroSeries } from "../_lib/overview";

const K = FrontendI18nKeys.common.analytics;
const S = K.sales;
const CHART_HEIGHT = 200;

export interface SalesTabProps {
  /** Null on the first load: every card draws its own skeleton. */
  sales: AnalyticsSales | null;
  x: readonly string[];
  currency: string;
  productName: (id: string | null) => string | null;
  stale: boolean;
}

type Bar = { id: string; label: string; value: number; display: string; color?: string };

/**
 * The Sales tab (F-1001-e, panel-web `contract.analytics.md` "Other tabs"):
 * package vs usage sales, sales and top-ups as two charts (never one sum,
 * ADR-0067), payment success by gateway, discounts and gifts, refunds by
 * product. Every figure is billing's `sales` answer, drawn in one currency.
 */
export function SalesTab({ sales, x, currency, productName, stale }: SalesTabProps) {
  const { t, lang } = useLocale();
  const fmt = useChartFormat();
  const state = sales ? "ready" : "loading";
  const money = (n: number) => formatMoney(n, currency, { lang, t });
  const kpi = (k: "refunds" | "discounts" | "giftsCredited") => ({ value: amountIn(sales?.[k].value, currency) ?? 0, delta: sales?.[k].delta[currency] ?? null });

  // A bucket hidden from the platform's staff is null; a column needs a number, and its table row says "—".
  const columns = x.map((label, i) => ({ x: label, package: amountIn(sales?.series.salesPackage[i], currency), usage: amountIn(sales?.series.salesUsage[i], currency) }));
  const net = sales ? heroSeries(sales.series, "net", currency) : [];
  const netBefore = sales?.previousSeries ? heroSeries(sales.previousSeries, "net", currency) : undefined;
  const topUps = sales ? heroSeries(sales.series, "topUps", currency) : [];
  const topUpsBefore = sales?.previousSeries ? heroSeries(sales.previousSeries, "topUps", currency) : undefined;
  const trendRows = (values: readonly (number | null)[]) => x.map((label, i) => ({ x: label, value: values[i] ?? null }));
  const cell = (v: number | null) => (v === null ? "—" : money(v));

  const gateways: Bar[] = (sales?.payments.byKind ?? []).map((g) => ({ id: g.gatewayKind ?? "none", label: g.gatewayKind ?? "—", value: g.successRate ?? 0, display: g.successRate === null ? "—" : fmt.percent(g.successRate) }));
  const refundCells = sales?.refundsByProduct ?? [];
  const refunds: Bar[] = refundCells.flatMap((r) =>
    "people" in r && r.people === FEWER_THAN_5 ? [] : "refunds" in r ? [{ id: r.productId ?? "none", label: productName(r.productId) ?? t("common", K.byProduct.unnamed), value: amountIn(r.refunds, currency) ?? 0, display: money(amountIn(r.refunds, currency) ?? 0) }] : [],
  );
  const hiddenRefunds = refundCells.length - refunds.length;
  const barTable = (header: string) => ({
    columns: [
      { id: "label", header, cell: (r: Bar) => r.label },
      { id: "value", header: t("common", K.table.value), cell: (r: Bar) => r.display, dir: "ltr" as const },
    ],
    rows: [] as Bar[],
    rowKey: (r: Bar) => r.id,
  });

  return (
    <div className="flex flex-col gap-4">
      {sales && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label={t("common", S.kpis.successRate)}
            value={sales.payments.successRate ?? 0}
            format={fmt.percent}
            footer={<Meter value={sales.payments.successRate} label={t("common", S.kpis.successRate)} />}
          />
          <StatTile label={t("common", S.kpis.discounts)} value={kpi("discounts").value} format={money} delta={kpi("discounts").delta} />
          <StatTile label={t("common", S.kpis.gifts)} value={kpi("giftsCredited").value} format={money} delta={kpi("giftsCredited").delta} />
          <StatTile label={t("common", S.kpis.refunds)} value={kpi("refunds").value} format={money} delta={kpi("refunds").delta} downIsGood />
        </div>
      )}

      <ChartCard<(typeof columns)[number]>
        title={t("common", S.byKind.title)}
        subtitle={t("common", S.byKind.subtitle)}
        state={state}
        stale={stale}
        height={CHART_HEIGHT}
        legend={[
          { id: "package", label: t("common", S.byKind.package), color: slotColor(0) },
          { id: "usage", label: t("common", S.byKind.usage), color: slotColor(1) },
        ]}
        table={{
          columns: [
            { id: "x", header: t("common", K.table.date), cell: (r) => r.x },
            { id: "package", header: t("common", S.byKind.package), cell: (r) => cell(r.package), dir: "ltr" },
            { id: "usage", header: t("common", S.byKind.usage), cell: (r) => cell(r.usage), dir: "ltr" },
          ],
          rows: columns,
          rowKey: (r) => r.x,
        }}
      >
        <StackedColumns
          label={t("common", S.byKind.title)}
          x={x}
          height={CHART_HEIGHT}
          formatValue={money}
          formatTick={fmt.compact}
          series={[
            { id: "package", label: t("common", S.byKind.package), values: columns.map((c) => c.package ?? 0), color: slotColor(0) },
            { id: "usage", label: t("common", S.byKind.usage), values: columns.map((c) => c.usage ?? 0), color: slotColor(1) },
          ]}
        />
      </ChartCard>

      {/* Sales and top-ups are two charts, never one sum (ADR-0067; chart rule 1). */}
      <div className="grid gap-4 lg:grid-cols-2">
        {[
          { id: "net", title: S.net.title, subtitle: S.net.subtitle, values: net, previous: netBefore },
          { id: "topUps", title: S.topUps.title, subtitle: S.topUps.subtitle, values: topUps, previous: topUpsBefore },
        ].map((chart) => (
          <ChartCard<{ x: string; value: number | null }>
            key={chart.id}
            title={t("common", chart.title)}
            subtitle={t("common", chart.subtitle)}
            state={state}
            stale={stale}
            height={CHART_HEIGHT}
            table={{
              columns: [
                { id: "x", header: t("common", K.table.date), cell: (r) => r.x },
                { id: "value", header: t("common", K.table.value), cell: (r) => cell(r.value), dir: "ltr" },
              ],
              rows: trendRows(chart.values),
              rowKey: (r) => r.x,
            }}
          >
            <TrendChart label={t("common", chart.title)} x={x} series={[{ id: chart.id, label: t("common", chart.title), values: chart.values }]} previous={chart.previous} variant="area" height={CHART_HEIGHT} formatValue={money} formatTick={fmt.compact} />
          </ChartCard>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard<Bar>
          title={t("common", S.gateways.title)}
          subtitle={sales ? t("common", S.gateways.subtitle, { settled: fmt.full(sales.payments.settled), started: fmt.full(sales.payments.started) }) : undefined}
          state={sales && sales.payments.byKind?.length === 0 ? "empty" : state}
          stale={stale}
          table={{ ...barTable(t("common", S.gateways.title)), rows: gateways }}
        >
          {sales?.payments.byKind === null ? <p className="text-sm text-text-secondary">{t("common", S.gateways.hidden)}</p> : <BarList label={t("common", S.gateways.title)} items={gateways} formatValue={fmt.percent} />}
        </ChartCard>

        <ChartCard<Bar>
          title={t("common", S.refunds.title)}
          subtitle={hiddenRefunds > 0 ? t("common", K.byProduct.hidden, { count: fmt.full(hiddenRefunds) }) : t("common", S.refunds.subtitle)}
          state={sales && refundCells.length === 0 ? "empty" : state}
          stale={stale}
          table={{ ...barTable(t("common", K.table.product)), rows: refunds }}
        >
          <BarList label={t("common", S.refunds.title)} items={refunds} formatValue={money} />
        </ChartCard>
      </div>
    </div>
  );
}
