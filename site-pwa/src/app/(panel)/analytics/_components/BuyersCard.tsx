"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ChartCard, StackedColumns, slotColor, useChartFormat } from "../../_components/kit/charts";

const K = FrontendI18nKeys.common.analytics;

/**
 * New vs returning buyers per bucket (F-1001-d), one card: the Overview's and
 * the Customers tab's (F-1001-g). A bucket hidden from the platform's staff
 * arrives null and is drawn as nobody.
 */
export function BuyersCard({ x, fresh, returning, loading, stale }: { x: readonly string[]; fresh: readonly (number | null)[]; returning: readonly (number | null)[]; loading: boolean; stale: boolean }) {
  const { t } = useLocale();
  const fmt = useChartFormat();
  const rows = x.map((label, i) => ({ x: label, fresh: fresh[i] ?? 0, returning: returning[i] ?? 0 }));
  const series = [
    { id: "new", label: t("common", K.buyers.new), color: slotColor(0), values: rows.map((r) => r.fresh) },
    { id: "returning", label: t("common", K.buyers.returning), color: slotColor(1), values: rows.map((r) => r.returning) },
  ];
  return (
    <ChartCard<(typeof rows)[number]>
      title={t("common", K.buyers.title)}
      subtitle={t("common", K.buyers.subtitle)}
      state={loading ? "loading" : "ready"}
      stale={stale}
      legend={series.map(({ id, label, color }) => ({ id, label, color }))}
      table={{
        columns: [
          { id: "x", header: t("common", K.table.date), cell: (r) => r.x },
          { id: "new", header: series[0].label, cell: (r) => fmt.full(r.fresh), dir: "ltr" },
          { id: "returning", header: series[1].label, cell: (r) => fmt.full(r.returning), dir: "ltr" },
        ],
        rows,
        rowKey: (r) => r.x,
      }}
    >
      <StackedColumns label={t("common", K.buyers.title)} x={x} series={series} />
    </ChartCard>
  );
}
