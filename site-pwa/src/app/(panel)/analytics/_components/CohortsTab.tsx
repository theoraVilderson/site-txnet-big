"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AnalyticsCohorts } from "@/lib/billing/analytics";
import { formatMoney } from "../../_lib/money";
import { SegmentedControl } from "../../_components/kit";
import { ChartCard, CohortGrid, type CohortGridRow, TrendChart, slotColor, useChartFormat } from "../../_components/kit/charts";
import { COHORT_METRICS, type CohortMetric, channelCurves, gridOf } from "../_lib/cohorts";
import { sourceNamer } from "../_lib/sources";

const K = FrontendI18nKeys.common.analytics;
const H = K.cohorts;
const CHART_HEIGHT = 220;
/** A line chart names at most this many series (chart rule 5); every channel is in its table. */
const CHANNELS_DRAWN = 4;

export interface CohortsTabProps {
  /** Null on the first load: every card draws its own skeleton. */
  cohorts: AnalyticsCohorts | null;
  currency: string;
  /** A cohort's month in the reader's calendar. */
  formatMonth: (day: string) => string;
  stale: boolean;
}

/**
 * The Cohorts tab (F-1004-b, panel-web `contract.analytics-tabs.md` "Cohorts";
 * billing `cohorts`, F-1004-a): the retention grid — first-purchase month by
 * month k, one metric at a time (share still buying, net per member, LTV) —
 * and LTV per channel, the channel being the signup source (ADR-0149 (5)).
 */
export function CohortsTab({ cohorts, currency, formatMonth, stale }: CohortsTabProps) {
  const { t, lang } = useLocale();
  const fmt = useChartFormat();
  const [metric, setMetric] = useState<CohortMetric>("share");
  const state = !cohorts ? "loading" : cohorts.cohorts.length === 0 ? "empty" : "ready";
  const money = (n: number) => formatMoney(n, currency, { lang, t });
  const write = (v: number | null) => (v === null ? "" : metric === "share" ? fmt.percent(v) : money(v));
  const sourceName = sourceNamer(t);

  const grid = cohorts ? gridOf(cohorts, metric, currency) : { columns: 0, rows: [] };
  const monthLabels = Array.from({ length: grid.columns }, (_, k) => t("common", H.grid.month, { k }));
  const rows: CohortGridRow[] = grid.rows.map((r) =>
    "hidden" in r
      ? { id: r.cohort, label: formatMonth(r.cohort), hidden: t("common", K.catalog.fewerThan5) }
      : { id: r.cohort, label: formatMonth(r.cohort), size: fmt.full(r.users), values: r.values, display: r.values.map(write) },
  );
  const flat = grid.rows.flatMap((r) => ("hidden" in r ? [] : r.values.flatMap((v, k) => (v === null ? [] : [{ id: `${r.cohort}-${k}`, cohort: formatMonth(r.cohort), k: monthLabels[k], value: write(v) }]))));

  const curves = cohorts ? channelCurves(cohorts, currency, grid.columns) : [];
  const drawn = curves.slice(0, CHANNELS_DRAWN);
  const curveRows = curves.flatMap((c) => c.values.flatMap((v, k) => (v === null ? [] : [{ id: `${c.source}-${k}`, source: sourceName(c.source), k: monthLabels[k], value: money(v) }])));

  return (
    <div className="flex flex-col gap-4">
      <ChartCard<(typeof flat)[number]>
        title={t("common", H.grid.title)}
        subtitle={t("common", H.grid.subtitle)}
        state={state}
        stale={stale}
        actions={
          <SegmentedControl size="sm" ariaLabel={t("common", H.metric)} value={metric} onChange={setMetric} options={COHORT_METRICS.map((m) => ({ value: m, label: t("common", H.metrics[m]) }))} />
        }
        table={{
          columns: [
            { id: "cohort", header: t("common", H.grid.cohort), cell: (r) => r.cohort },
            { id: "k", header: t("common", H.grid.k), cell: (r) => r.k },
            { id: "value", header: t("common", H.metrics[metric]), cell: (r) => r.value, dir: "ltr" },
          ],
          rows: flat,
          rowKey: (r) => r.id,
        }}
      >
        <CohortGrid
          label={t("common", H.grid.title)}
          rowHeader={t("common", H.grid.cohort)}
          sizeHeader={t("common", H.grid.size)}
          columns={monthLabels}
          rows={rows}
          max={metric === "share" ? 1 : undefined}
        />
      </ChartCard>

      <ChartCard<(typeof curveRows)[number]>
        title={t("common", H.channels.title)}
        subtitle={t("common", H.channels.subtitle)}
        state={!cohorts ? "loading" : curves.length === 0 ? "empty" : "ready"}
        stale={stale}
        height={CHART_HEIGHT}
        legend={drawn.map((c, i) => ({ id: c.source, label: sourceName(c.source), color: slotColor(i) }))}
        table={{
          columns: [
            { id: "source", header: t("common", H.channels.source), cell: (r) => r.source },
            { id: "k", header: t("common", H.grid.k), cell: (r) => r.k },
            { id: "value", header: t("common", H.metrics.ltv), cell: (r) => r.value, dir: "ltr" },
          ],
          rows: curveRows,
          rowKey: (r) => r.id,
        }}
      >
        <TrendChart
          label={t("common", H.channels.title)}
          x={monthLabels}
          series={drawn.map((c, i) => ({ id: c.source, label: sourceName(c.source), values: c.values, color: slotColor(i) }))}
          height={CHART_HEIGHT}
          formatValue={money}
          formatTick={fmt.compact}
        />
      </ChartCard>
    </div>
  );
}
