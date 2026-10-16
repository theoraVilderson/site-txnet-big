"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AnalyticsOverview } from "@/lib/billing/analytics";
import { AnimatedNumber, Select } from "../../_components/kit";
import { ChartCard, DeltaPill, TrendChart, useChartFormat, useChartTheme } from "../../_components/kit/charts";
import { HERO_METRICS, type HeroMetric, heroFigure, heroSeries } from "../_lib/overview";

const K = FrontendI18nKeys.common.analytics;
const HERO_HEIGHT = 240;

export interface OverviewHeroProps {
  overview: AnalyticsOverview | null;
  /** The bucket labels, as the page writes a date in its calendar. */
  x: readonly string[];
  currency: string;
  metric: HeroMetric;
  onMetric: (metric: HeroMetric) => void;
  /** Money in `currency`, or a count — as `metric` is. */
  formatOf: (metric: HeroMetric) => (n: number) => string;
  state: "ready" | "loading";
  stale: boolean;
}

type Row = { x: string; value: number | null; previous: number | null };

/**
 * The hero (Overview 1): one metric as a large figure, its change, and its
 * trend with the compared window muted behind it — one chart, one axis
 * (rule 1). The picker, or a KPI tile, switches the metric.
 */
export function OverviewHero({ overview, x, currency, metric, onMetric, formatOf, state, stale }: OverviewHeroProps) {
  const { t } = useLocale();
  const fmt = useChartFormat();
  const { main, muted } = useChartTheme();
  const format = formatOf(metric);
  const values = overview ? heroSeries(overview.series, metric, currency) : [];
  const previous = overview?.previousSeries ? heroSeries(overview.previousSeries, metric, currency) : undefined;
  const figure = overview ? heroFigure(overview.kpis, metric, currency) : null;
  const label = t("common", K.hero.metrics[metric]);
  const rows: Row[] = x.map((day, i) => ({ x: day, value: values[i] ?? null, previous: previous?.[i] ?? null }));

  return (
    <ChartCard<Row>
      title={label}
      state={state}
      stale={stale}
      height={HERO_HEIGHT}
      legend={previous ? [{ id: "current", label: t("common", K.hero.current), color: main }, { id: "previous", label: t("common", K.hero.previous), color: muted, dashed: true }] : undefined}
      actions={
        // A picker, not four buttons: those were wider than a phone and pushed the page off its edge.
        <div className="w-44">
          <Select
            ariaLabel={t("common", K.hero.metric)}
            value={metric}
            onChange={(v) => onMetric(HERO_METRICS.find((m) => m === v) ?? metric)}
            options={HERO_METRICS.map((m) => ({ value: m, label: t("common", K.hero.metrics[m]) }))}
          />
        </div>
      }
      table={{
        columns: [
          { id: "x", header: t("common", K.table.date), cell: (r) => r.x },
          { id: "value", header: label, cell: (r) => (r.value === null ? "—" : format(r.value)), dir: "ltr" },
          ...(previous ? [{ id: "previous", header: t("common", K.table.previous), cell: (r: Row) => (r.previous === null ? "—" : format(r.previous)), dir: "ltr" as const }] : []),
        ],
        rows,
        rowKey: (r) => r.x,
      }}
    >
      {figure && (
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <AnimatedNumber value={figure.value} format={format} className="text-3xl font-black tabular-nums text-text-primary" />
          <DeltaPill delta={figure.delta} />
        </div>
      )}
      <TrendChart label={label} x={x} series={[{ id: metric, label, values }]} previous={previous} variant="area" height={HERO_HEIGHT} formatValue={format} formatTick={fmt.compact} />
    </ChartCard>
  );
}
