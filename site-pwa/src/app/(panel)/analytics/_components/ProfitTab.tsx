"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { TrendingDown } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { type AnalyticsMargin, LOSS_ALERT_PERCENT, type MarginCell } from "@/lib/billing/analytics";
import { PANEL_SYSTEMS } from "@/lib/routes";
import { formatList } from "../../_lib/digits";
import { formatMoney } from "../../_lib/money";
import { Alert, Badge, Card, CardHeader, DataTable, type DataColumn } from "../../_components/kit";
import { BarList, ChartCard, StatTile, TrendChart, slotColor, useChartFormat } from "../../_components/kit/charts";
import { amountIn } from "../_lib/overview";
import { AnalyticsSettingField } from "./AnalyticsSettingField";

const K = FrontendI18nKeys.common.analytics;
const P = K.profit;
const CHART_HEIGHT = 200;
const COST_PARTS = ["attributed", "idle", "unallocated"] as const;

type Row = MarginCell | { id: string | null; people: string };
const isShown = (row: Row): row is MarginCell => "net" in row;

export interface ProfitTabProps {
  /** Null on the first load: every card draws its own skeleton. */
  margin: AnalyticsMargin | null;
  x: readonly string[];
  currency: string;
  productName: (id: string | null) => string | null;
  panelName: (id: string | null) => string | null;
  /** Where a user's page is, for the losing users' list. */
  userHref: (userId: string) => string;
  /** Where this tenant's products are costed — its catalog (F-1002-h). */
  catalogHref: string;
  /** The loss alert's form (F-1003), for the settings key's holders; null hides it. */
  setting: { tenantId: string; onSaved: () => void } | null;
  stale: boolean;
}

/**
 * The Profit tab (F-1001-m, panel-web `contract.analytics-tabs.md` "Profit";
 * billing `margin`, F-1001-l): net, cost, margin and its rate; sales against
 * cost over time and where the cost went; then margin per product, panel and
 * losing user, and on the platform's own view per reseller. A loss says so in
 * a word beside its colour (chart rule 4); a panel with no cost set is named,
 * with the way to set it, so its perfect margin is not believed. The settings
 * key's holders set the percent past which a user is reported (F-1003).
 */
export function ProfitTab({ margin, x, currency, productName, panelName, userHref, catalogHref, setting, stale }: ProfitTabProps) {
  const { t, lang } = useLocale();
  const fmt = useChartFormat();
  const state = margin ? "ready" : "loading";
  const money = (n: number) => formatMoney(n, currency, { lang, t });
  const kpi = (k: "net" | "cost" | "margin") => ({ value: amountIn(margin?.totals[k].value, currency) ?? 0, delta: margin?.totals[k].delta[currency] ?? null });

  const net = (margin?.series.net ?? []).map((v) => amountIn(v, currency));
  const cost = (margin?.series.cost ?? []).map((v) => amountIn(v, currency));
  const trendRows = x.map((label, i) => ({ x: label, net: net[i] ?? null, cost: cost[i] ?? null }));
  const cell = (v: number | null) => (v === null ? "—" : money(v));
  const parts = COST_PARTS.map((part, i) => {
    const value = amountIn(margin?.costParts[part], currency) ?? 0;
    return { id: part, label: t("common", P.parts[part]), value, display: money(value), color: slotColor(i) };
  });
  const noCost = margin?.noCostPanels ?? [];
  const noCostProducts = margin?.noCostProducts ?? [];

  return (
    <div className="flex flex-col gap-4">
      {margin && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label={t("common", P.kpis.net)} value={kpi("net").value} format={money} delta={kpi("net").delta} />
          <StatTile label={t("common", P.kpis.cost)} value={kpi("cost").value} format={money} delta={kpi("cost").delta} downIsGood />
          <StatTile label={t("common", P.kpis.margin)} value={kpi("margin").value} format={money} delta={kpi("margin").delta} />
          <StatTile label={t("common", P.kpis.marginRate)} value={margin.totals.marginRate ?? 0} format={(n) => (margin.totals.marginRate === null ? "—" : fmt.percent(n))} />
        </div>
      )}

      {noCost.length > 0 && (
        <Alert
          tone="warning"
          title={t("common", P.noCost.title)}
          action={
            <Link href={PANEL_SYSTEMS} className="text-sm font-semibold text-primary hover:underline">
              {t("common", P.noCost.action)}
            </Link>
          }
        >
          {t("common", P.noCost.body, { panels: formatList(noCost.map((id) => panelName(id) ?? t("common", K.catalog.unnamedPanel)), lang) })}
        </Alert>
      )}

      {noCostProducts.length > 0 && (
        <Alert
          tone="warning"
          title={t("common", P.noCostProducts.title)}
          action={
            <Link href={catalogHref} className="text-sm font-semibold text-primary hover:underline">
              {t("common", P.noCostProducts.action)}
            </Link>
          }
        >
          {t("common", P.noCostProducts.body, { products: formatList(noCostProducts.map((id) => productName(id) ?? t("common", K.byProduct.unnamed)), lang) })}
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Sales and cost are one unit, money: one axis, two series (chart rule 1). */}
        <ChartCard<(typeof trendRows)[number]>
          title={t("common", P.trend.title)}
          subtitle={t("common", P.trend.subtitle)}
          state={state}
          stale={stale}
          height={CHART_HEIGHT}
          legend={[
            { id: "net", label: t("common", P.trend.net), color: slotColor(0) },
            { id: "cost", label: t("common", P.trend.cost), color: slotColor(1) },
          ]}
          table={{
            columns: [
              { id: "x", header: t("common", K.table.date), cell: (r) => r.x },
              { id: "net", header: t("common", P.trend.net), cell: (r) => cell(r.net), dir: "ltr" },
              { id: "cost", header: t("common", P.trend.cost), cell: (r) => cell(r.cost), dir: "ltr" },
            ],
            rows: trendRows,
            rowKey: (r) => r.x,
          }}
        >
          <TrendChart
            label={t("common", P.trend.title)}
            x={x}
            series={[
              { id: "net", label: t("common", P.trend.net), values: net, color: slotColor(0) },
              { id: "cost", label: t("common", P.trend.cost), values: cost, color: slotColor(1) },
            ]}
            height={CHART_HEIGHT}
            formatValue={money}
            formatTick={fmt.compact}
          />
        </ChartCard>

        <ChartCard<(typeof parts)[number]>
          title={t("common", P.parts.title)}
          subtitle={t("common", P.parts.subtitle)}
          state={state}
          stale={stale}
          table={{
            columns: [
              { id: "label", header: t("common", P.parts.title), cell: (r) => r.label },
              { id: "value", header: t("common", K.table.value), cell: (r) => r.display, dir: "ltr" },
            ],
            rows: parts,
            rowKey: (r) => r.id,
          }}
        >
          <BarList label={t("common", P.parts.title)} items={parts} formatValue={money} />
        </ChartCard>
      </div>

      {margin && (
        <>
          <MarginTable title={t("common", P.products)} rows={margin.products} currency={currency} nameOf={(id) => productName(id) ?? t("common", K.byProduct.unnamed)} />
          {margin.panels.length > 0 && <MarginTable title={t("common", P.panels)} rows={margin.panels} currency={currency} nameOf={(id) => panelName(id) ?? t("common", K.catalog.unnamedPanel)} />}
          {setting && (
            <AnalyticsSettingField
              tenantId={setting.tenantId}
              field="lossAlertPercent"
              current={margin.lossAlertPercent}
              bounds={LOSS_ALERT_PERCENT}
              words={{
                label: t("common", P.lossAlert.label),
                hint: t("common", P.lossAlert.hint, { min: LOSS_ALERT_PERCENT.min, max: LOSS_ALERT_PERCENT.max }),
                save: t("common", P.lossAlert.save),
                saved: (percent) => t("common", P.lossAlert.saved, { percent }),
              }}
              onSaved={setting.onSaved}
            />
          )}
          {margin.users && (
            <MarginTable title={t("common", P.users)} subtitle={t("common", P.usersSubtitle)} rows={margin.users} currency={currency} nameOf={(id) => margin.users?.find((u) => u.id === id)?.name ?? t("common", P.unnamedUser)} hrefOf={userHref} />
          )}
          {margin.resellers && (
            <MarginTable
              title={t("common", P.resellers)}
              subtitle={t("common", P.resellersSubtitle)}
              rows={margin.resellers}
              currency={currency}
              nameOf={(id) => margin.resellers?.find((r) => r.id === id)?.name ?? id ?? ""}
            />
          )}
        </>
      )}
    </div>
  );
}

interface MarginTableProps {
  title: string;
  subtitle?: string;
  rows: readonly Row[];
  currency: string;
  nameOf: (id: string | null) => string;
  /** A row's page, when it has one. */
  hrefOf?: (id: string) => string;
}

/** One margin list: name, net, cost, margin with its loss word, and the rate; a hidden row in words. */
function MarginTable({ title, subtitle, rows, currency, nameOf, hrefOf }: MarginTableProps) {
  const { t, lang } = useLocale();
  const fmt = useChartFormat();
  const money = (v: string | undefined) => formatMoney(v ?? "0", currency, { lang, t });
  const hidden = t("common", K.catalog.fewerThan5);
  const figure = (pick: (r: MarginCell) => ReactNode) => (r: Row) => (isShown(r) ? pick(r) : hidden);

  const columns: DataColumn<Row>[] = [
    {
      id: "name",
      header: title,
      cell: (r) =>
        r.id && hrefOf ? (
          <Link href={hrefOf(r.id)} className="font-semibold text-primary hover:underline">
            {nameOf(r.id)}
          </Link>
        ) : (
          nameOf(r.id)
        ),
    },
    { id: "net", header: t("common", K.profit.net), cell: figure((r) => money(r.net[currency])), dir: "ltr" },
    {
      id: "cost",
      header: t("common", K.profit.cost),
      // No cost row is not a cost of 0 (ADR-0151 (5)): said in words, so the margin beside it is not believed.
      cell: figure((r) => (r.noCost ? <Badge tone="warning">{t("common", K.profit.noCostSet)}</Badge> : money(r.cost[currency]))),
      dir: "ltr",
    },
    {
      id: "margin",
      header: t("common", K.profit.margin),
      cell: figure((r) => (
        <span className="inline-flex items-center gap-2">
          {money(r.margin[currency])}
          {r.loss && (
            <Badge tone="error" icon={<TrendingDown size={12} aria-hidden />}>
              {t("common", K.profit.loss)}
            </Badge>
          )}
        </span>
      )),
      dir: "ltr",
    },
    { id: "rate", header: t("common", K.profit.marginRate), cell: figure((r) => (r.marginRate === null || r.noCost ? "—" : fmt.percent(r.marginRate))), dir: "ltr", hideOnCard: true },
  ];

  return (
    <Card padding="sm">
      <CardHeader title={title} subtitle={subtitle} className="mb-2" />
      <DataTable label={title} rows={rows} columns={columns} rowKey={(r) => r.id ?? "none"} empty={<p className="p-4 text-sm text-text-secondary">{t("common", K.profit.empty)}</p>} compact bare />
    </Card>
  );
}
