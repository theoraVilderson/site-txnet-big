"use client";

import Link from "next/link";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AnalyticsResellers, ResellerRow } from "@/lib/billing/analytics";
import { myResellerAnalyticsPath } from "@/lib/routes";
import { formatMoney } from "../../_lib/money";
import { Card, CardHeader, DataTable, type DataColumn } from "../../_components/kit";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { DeltaPill, Sparkline, useChartFormat } from "../../_components/kit/charts";
import { amountIn } from "../_lib/overview";

const K = FrontendI18nKeys.common.analytics;
const R = K.resellers;
const SKELETON_ROWS = 5;

/** The columns both the tab and the Overview's card draw — one reading of a reseller's row. */
export function useResellerColumns(currency: string, compact = false): DataColumn<ResellerRow>[] {
  const { t, lang } = useLocale();
  const fmt = useChartFormat();
  const money = (v: string | undefined) => formatMoney(v ?? "0", currency, { lang, t });
  return [
    { id: "name", header: t("common", R.reseller), cell: (r) => <Link href={myResellerAnalyticsPath(r.resellerId)} className="font-semibold text-primary hover:underline">{r.name}</Link> },
    {
      id: "net",
      header: t("common", K.catalog.net),
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          {money(r.net.value[currency])}
          <DeltaPill delta={r.net.delta[currency] ?? null} />
        </span>
      ),
      dir: "ltr",
    },
    ...(compact
      ? []
      : [
          { id: "topUps", header: t("common", R.topUps), cell: (r: ResellerRow) => money(r.topUps[currency]), dir: "ltr" as const, hideOnCard: true },
          { id: "buyers", header: t("common", K.catalog.buyers), cell: (r: ResellerRow) => fmt.full(r.buyers), dir: "ltr" as const },
          { id: "active", header: t("common", R.activeGrants), cell: (r: ResellerRow) => fmt.full(r.activeGrants), dir: "ltr" as const, hideOnCard: true },
        ]),
    // A point billing hid (under 5 buyers) is null: a gap in the line, never a zero.
    { id: "trend", header: t("common", K.catalog.trend), cell: (r) => <Sparkline values={r.sparkline.map((p) => (p === null ? null : amountIn(p, currency)))} />, hideOnCard: true },
  ];
}

/**
 * The Resellers tab (F-1001-i, panel-web `contract.analytics.md` "Other tabs";
 * billing `resellers`, F-1001-h): the platform's leaderboard, tier A — each
 * reseller's whole-business figures, its name opening its own analytics.
 * Product and panel filters do not narrow it; billing says so by ignoring them.
 */
export function ResellersTab({ resellers, currency }: { resellers: AnalyticsResellers | null; currency: string }) {
  const { t } = useLocale();
  const fmt = useChartFormat();
  const columns = useResellerColumns(currency);
  if (!resellers) return <TableSkeleton rows={SKELETON_ROWS} withPagination={false} />;
  return (
    <Card padding="sm">
      <CardHeader title={t("common", R.title)} subtitle={t("common", R.count, { shown: fmt.full(resellers.resellers.length), total: fmt.full(resellers.total) })} className="mb-2" />
      <DataTable label={t("common", R.title)} rows={resellers.resellers} columns={columns} rowKey={(r) => r.resellerId} empty={<p className="p-4 text-sm text-text-secondary">{t("common", R.empty)}</p>} compact bare />
    </Card>
  );
}
