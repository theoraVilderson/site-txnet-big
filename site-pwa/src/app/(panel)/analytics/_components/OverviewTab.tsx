"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { type AnalyticsNames, type AnalyticsOverview, FEWER_THAN_5 } from "@/lib/billing/analytics";
import { formatMoney } from "../../_lib/money";
import { BarList, CHART_OTHER, CalendarHeatmap, ChartCard, Meter, StatTile, slotsByEntity, useChartFormat } from "../../_components/kit/charts";
import { type AnalyticsFilters } from "../_lib/filters";
import { insightLines } from "../_lib/insights";
import { type HeroMetric, MONEY_METRICS, amountIn, catalogOrder } from "../_lib/overview";
import { usageFormat } from "../_lib/usage";
import { OverviewHero } from "./OverviewHero";
import { OverviewInsights } from "./OverviewInsights";
import { BuyersCard } from "./BuyersCard";
import { UsageCards, usagePoints } from "./UsageCards";

const K = FrontendI18nKeys.common.analytics;

/** The Saturday a Jalali week starts on, the Monday otherwise (JS weekdays) — billing cuts weeks the same way. */
const WEEK_START = { jalali: 6, gregorian: 1 } as const;

export interface OverviewTabProps {
  overview: AnalyticsOverview | null;
  names: AnalyticsNames | null;
  /** The bucket labels, as the page writes a date in its calendar. */
  x: readonly string[];
  currency: string;
  calendar: keyof typeof WEEK_START;
  formatDay: (day: string) => string;
  productName: (id: string | null) => string | null;
  /** A meter's name in the reader's language (F-1001-o). */
  meterName: (key: string) => string;
  /** The current view with `patch` applied — where an insight links. */
  hrefOf: (patch: Partial<AnalyticsFilters>) => string;
  stale: boolean;
}

type Bar = { id: string; label: string; value: number; display: string; color: string };

/**
 * The Overview tab (F-1001-d, panel-web `contract.analytics.md` "Overview"):
 * the hero, six KPI tiles, the insights strip (F-1001-k), sales by product
 * beside new vs returning buyers, and the year's calendar. The owner's top
 * resellers (F-1001-i) arrive with their row. `overview` null is the first load: every
 * card draws its own skeleton.
 */
export function OverviewTab({ overview, names, x, currency, calendar, formatDay, productName, meterName, hrefOf, stale }: OverviewTabProps) {
  const { t, lang } = useLocale();
  const fmt = useChartFormat();
  const [metric, setMetric] = useState<HeroMetric>("net");
  const state = overview ? "ready" : "loading";
  const money = (n: number) => formatMoney(n, currency, { lang, t });
  const formatOf = (m: HeroMetric) => (MONEY_METRICS.has(m) ? money : fmt.full);
  const kpis = overview?.kpis;
  // A meter's unit is billing's word for it; one the names do not list is written as a count.
  const units = new Map((names?.meters ?? []).map((m) => [m.key, m.unit]));
  const formatOfMeter = (key: string) => usageFormat(units.get(key) ?? "count", { lang, t, fmt });

  const slotOf = slotsByEntity(names ? catalogOrder(names) : []);
  const shown = (overview?.byProduct.top ?? []).flatMap((p) => ("people" in p && p.people === FEWER_THAN_5 ? [] : [p]));
  const hiddenCount = (overview?.byProduct.top.length ?? 0) - shown.length;
  const bars: Bar[] = shown.map((p) => {
    const value = "net" in p ? (amountIn(p.net, currency) ?? 0) : 0;
    return { id: p.productId ?? "none", label: productName(p.productId) ?? t("common", K.byProduct.unnamed), value, display: money(value), color: p.productId ? slotOf(p.productId) : CHART_OTHER };
  });
  const other = overview?.byProduct.other ? amountIn(overview.byProduct.other.net, currency) : null;

  const heat = (overview?.calendar ?? []).map((c) => ({ day: c.day, value: amountIn(c.net, currency) }));
  const insights = insightLines(overview?.insights ?? [], { t, percent: fmt.percent, money: (amount, code) => formatMoney(amount, code, { lang, t }), formatDay, productName, hrefOf });

  return (
    <div className="flex flex-col gap-4">
      <OverviewHero overview={overview} x={x} currency={currency} metric={metric} onMetric={setMetric} formatOf={formatOf} state={state} stale={stale} />

      {kpis && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label={t("common", K.kpis.orders)} value={kpis.orders.value} format={fmt.full} delta={kpis.orders.delta} onSelect={() => setMetric("orders")} selected={metric === "orders"} />
          <StatTile label={t("common", K.kpis.aov)} value={amountIn(kpis.aov.value, currency) ?? 0} format={money} delta={kpis.aov.delta[currency] ?? null} />
          <StatTile
            label={t("common", K.kpis.buyers)}
            value={kpis.buyers.value}
            format={fmt.full}
            delta={kpis.buyers.delta}
            onSelect={() => setMetric("newBuyers")}
            selected={metric === "newBuyers"}
            footer={t("common", K.kpis.buyersSplit, { new: fmt.full(kpis.newBuyers.value), returning: fmt.full(kpis.returningBuyers.value) })}
          />
          <StatTile
            label={t("common", K.kpis.renewal)}
            value={kpis.renewal.rate ?? 0}
            // No ended service yet is no rate: a dash, never 0%.
            format={(n) => (kpis.renewal.rate === null ? "—" : fmt.percent(n))}
            footer={<Meter value={kpis.renewal.rate} label={t("common", K.kpis.renewal)} />}
          />
          <StatTile label={t("common", K.kpis.activeGrants)} value={kpis.activeGrants.value} format={fmt.full} delta={kpis.activeGrants.delta} />
          {/* One tile per meter used (ADR-0148 (5)), in its own unit — no "traffic" tile for a shop that sells no VPN. */}
          {(overview?.usage ?? []).map((u) => (
            <StatTile key={u.meterKey} label={meterName(u.meterKey)} value={Number(u.total)} format={formatOfMeter(u.meterKey)} delta={u.delta} spark={usagePoints(u.series)} />
          ))}
        </div>
      )}

      <OverviewInsights lines={insights} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard<Bar>
          title={t("common", K.byProduct.title)}
          subtitle={hiddenCount > 0 ? t("common", K.byProduct.hidden, { count: fmt.full(hiddenCount) }) : t("common", K.byProduct.subtitle)}
          state={overview && bars.length === 0 && other === null ? "empty" : state}
          stale={stale}
          table={{
            columns: [
              { id: "product", header: t("common", K.table.product), cell: (r) => r.label },
              { id: "value", header: t("common", K.table.value), cell: (r) => r.display, dir: "ltr" },
            ],
            rows: bars,
            rowKey: (r) => r.id,
          }}
        >
          <BarList label={t("common", K.byProduct.title)} items={bars} other={other} formatValue={money} />
        </ChartCard>

        <BuyersCard x={x} fresh={overview?.series.newBuyers ?? []} returning={overview?.series.returningBuyers ?? []} loading={!overview} stale={stale} />
      </div>

      <UsageCards usage={overview?.usage ?? []} x={x} meterName={meterName} formatOf={formatOfMeter} stale={stale} />

      <ChartCard<(typeof heat)[number]>
        title={t("common", K.calendar.title)}
        subtitle={t("common", K.calendar.subtitle)}
        state={state}
        stale={stale}
        table={{
          columns: [
            { id: "day", header: t("common", K.table.date), cell: (r) => formatDay(r.day) },
            { id: "value", header: t("common", K.table.value), cell: (r) => (r.value === null ? "—" : money(r.value)), dir: "ltr" },
          ],
          rows: heat,
          rowKey: (r) => r.day,
        }}
      >
        <CalendarHeatmap label={t("common", K.calendar.title)} days={heat} weekStartsOn={WEEK_START[calendar]} formatDay={formatDay} formatValue={money} />
      </ChartCard>
    </div>
  );
}
