"use client";

import Link from "next/link";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AnalyticsCatalog, CatalogCell } from "@/lib/billing/analytics";
import { formatMoney } from "../../_lib/money";
import { Card, CardHeader, DataTable, type DataColumn } from "../../_components/kit";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { Sparkline, useChartFormat } from "../../_components/kit/charts";
import { formatBytes } from "../../services/_lib/service-configs";
import type { AnalyticsFilters } from "../_lib/filters";
import { amountIn } from "../_lib/overview";

const K = FrontendI18nKeys.common.analytics;
const C = K.catalog;
const SKELETON_ROWS = 4;

type Shown = Extract<CatalogCell, { net: unknown }>;
const isShown = (row: CatalogCell): row is Shown => "net" in row;

export interface CatalogTabProps {
  /** Null on the first load. */
  catalog: AnalyticsCatalog | null;
  currency: string;
  productName: (id: string | null) => string | null;
  panelName: (id: string | null) => string | null;
  /** The current view with `patch` applied — where a row's link goes. */
  hrefOf: (patch: Partial<AnalyticsFilters>) => string;
}

/**
 * Products and panels (F-1001-e, panel-web `contract.analytics.md` "Other
 * tabs"): one table each, every row with its trend and share, and a name that
 * opens the Overview filtered to it. The panel table is drawn only when the
 * window has a panel, and the traffic columns only when a row moved a byte —
 * a shop that sells no VPN sees neither (ADR-0148 (4)). A row under 5 buyers,
 * hidden from the platform's staff, says so in place of its figures.
 */
export function CatalogTab({ catalog, currency, productName, panelName, hrefOf }: CatalogTabProps) {
  const { t } = useLocale();
  if (!catalog) return <TableSkeleton rows={SKELETON_ROWS} withPagination={false} />;
  return (
    <div className="flex flex-col gap-4">
      <CatalogTable title={t("common", C.products)} rows={catalog.products} currency={currency} nameOf={(id) => productName(id) ?? t("common", K.byProduct.unnamed)} hrefOf={(id) => hrefOf({ tab: "overview", product: id })} />
      {catalog.panels.length > 0 && (
        <CatalogTable title={t("common", C.panels)} rows={catalog.panels} currency={currency} nameOf={(id) => panelName(id) ?? t("common", C.unnamedPanel)} hrefOf={(id) => hrefOf({ tab: "overview", panel: id })} />
      )}
    </div>
  );
}

interface CatalogTableProps {
  title: string;
  rows: readonly CatalogCell[];
  currency: string;
  nameOf: (id: string | null) => string;
  hrefOf: (id: string) => string;
}

function CatalogTable({ title, rows, currency, nameOf, hrefOf }: CatalogTableProps) {
  const { t, lang } = useLocale();
  const fmt = useChartFormat();
  const money = (v: string | undefined) => formatMoney(v ?? "0", currency, { lang, t });
  const hidden = t("common", C.fewerThan5);
  const figure = (pick: (r: Shown) => string) => (r: CatalogCell) => (isShown(r) ? pick(r) : hidden);
  const moved = rows.some((r) => isShown(r) && (r.bytesSold !== "0" || r.bytesUsed !== "0"));

  const columns: DataColumn<CatalogCell>[] = [
    {
      id: "name",
      header: title,
      // A row with no id (sales with no product or panel) has nothing to filter to.
      cell: (r) => (r.id ? <Link href={hrefOf(r.id)} scroll={false} className="font-semibold text-primary hover:underline">{nameOf(r.id)}</Link> : nameOf(null)),
    },
    { id: "net", header: t("common", C.net), cell: figure((r) => money(r.net[currency])), dir: "ltr" },
    { id: "orders", header: t("common", C.orders), cell: figure((r) => fmt.full(r.orders)), dir: "ltr" },
    { id: "buyers", header: t("common", C.buyers), cell: figure((r) => fmt.full(r.buyers)), dir: "ltr" },
    { id: "share", header: t("common", C.share), cell: figure((r) => (r.share === null ? "—" : fmt.percent(r.share))), dir: "ltr" },
    ...(moved
      ? [
          { id: "bytesSold", header: t("common", C.bytesSold), cell: figure((r) => formatBytes(r.bytesSold, lang) ?? ""), dir: "ltr" as const, hideOnCard: true },
          { id: "bytesUsed", header: t("common", C.bytesUsed), cell: figure((r) => formatBytes(r.bytesUsed, lang) ?? ""), dir: "ltr" as const, hideOnCard: true },
        ]
      : []),
    { id: "trend", header: t("common", C.trend), cell: (r) => (isShown(r) ? <Sparkline values={r.sparkline.map((p) => amountIn(p, currency))} /> : null), hideOnCard: true },
  ];

  return (
    <Card padding="sm">
      <CardHeader title={title} className="mb-2" />
      <DataTable label={title} rows={rows} columns={columns} rowKey={(r) => r.id ?? "none"} empty={<p className="p-4 text-sm text-text-secondary">{t("common", C.empty)}</p>} compact bare />
    </Card>
  );
}
