"use client";

import Link from "next/link";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { type AnalyticsCustomers, RENEWAL_WINDOW_DAYS, type RenewalFigures } from "@/lib/billing/analytics";
import { formatMoney } from "../../_lib/money";
import { Card, CardHeader, DataTable, type DataColumn } from "../../_components/kit";
import { BarList, ChartCard, Meter, StatTile, TrendChart, useChartFormat } from "../../_components/kit/charts";
import { amountIn } from "../_lib/overview";
import { BuyersCard } from "./BuyersCard";
import { AnalyticsSettingField } from "./AnalyticsSettingField";

const K = FrontendI18nKeys.common.analytics;
const C = K.customers;

/** The sources billing names that have words of their own. */
const SOURCE_KEYS: Record<string, string> = { web: C.sources.web, unknown: C.sources.unknown, telegram: C.sources.telegram, bale: C.sources.bale };

export interface CustomersTabProps {
  /** Null on the first load: every card draws its own skeleton. */
  customers: AnalyticsCustomers | null;
  x: readonly string[];
  currency: string;
  productName: (id: string | null) => string | null;
  /** Where a customer's page is; null where the reader has none to open. */
  userHref: ((userId: string) => string) | null;
  /** The renewal window form, for whom may change it; null hides it. */
  setting: { tenantId: string; onSaved: () => void } | null;
  stale: boolean;
}

type ProductRow = AnalyticsCustomers["renewalByProduct"][number];
type Customer = NonNullable<AnalyticsCustomers["topCustomers"]>[number];
const isShownProduct = (r: ProductRow): r is { productId: string | null } & RenewalFigures => "renewed" in r;

/**
 * The Customers tab (F-1001-g, panel-web `contract.analytics.md` "Other tabs";
 * the figures are billing's `customers`, F-1001-f): renewal with what is
 * still open beside it, signups and how many bought, new vs returning,
 * renewal by product and the top customers — a reseller's own people only.
 * The renewal window the figures were judged by is always said; changing it
 * is for the settings key's holders.
 */
export function CustomersTab({ customers, x, currency, productName, userHref, setting, stale }: CustomersTabProps) {
  const { t } = useLocale();
  const fmt = useChartFormat();
  const state = customers ? "ready" : "loading";
  const rate = useRate();
  const hidden = t("common", K.catalog.fewerThan5);
  const renewal = customers?.renewal;
  const signups = customers?.signups;

  // A source with words of its own is said in them; any other is a bot platform, named as it is.
  const sourceLabel = (source: string) => (SOURCE_KEYS[source] ? t("common", SOURCE_KEYS[source]) : source);
  const sources = (signups?.bySource ?? []).flatMap((s) => ("signups" in s ? [{ id: s.source, label: sourceLabel(s.source), value: s.signups, display: fmt.full(s.signups) }] : []));
  const hiddenSources = (signups?.bySource.length ?? 0) - sources.length;

  return (
    <div className="flex flex-col gap-4">
      {customers && renewal && signups && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label={t("common", C.renewalRate)}
            value={renewal.rate ?? 0}
            format={() => rate(renewal.rate)}
            footer={
              <>
                <Meter value={renewal.rate} label={t("common", C.renewalRate)} />
                <span className="text-2xs text-text-secondary">{t("common", C.renewalSplit, { renewed: fmt.full(renewal.renewed), lapsed: fmt.full(renewal.lapsed), pending: fmt.full(renewal.pending) })}</span>
              </>
            }
          />
          <StatTile label={t("common", C.signups)} value={signups.total} format={fmt.full} />
          <StatTile label={t("common", C.purchased7)} value={signups.purchased7.rate ?? 0} format={() => rate(signups.purchased7.rate)} footer={<Meter value={signups.purchased7.rate} label={t("common", C.purchased7)} />} />
          <StatTile label={t("common", C.purchased30)} value={signups.purchased30.rate ?? 0} format={() => rate(signups.purchased30.rate)} footer={<Meter value={signups.purchased30.rate} label={t("common", C.purchased30)} />} />
        </div>
      )}

      {customers && (
        <p className="text-xs text-text-secondary">{t("common", C.window.current, { days: fmt.full(customers.renewalWindowDays) })}</p>
      )}
      {customers && setting && (
        <AnalyticsSettingField
          tenantId={setting.tenantId}
          field="renewalWindowDays"
          current={customers.renewalWindowDays}
          bounds={RENEWAL_WINDOW_DAYS}
          words={{
            label: t("common", K.customers.window.label),
            hint: t("common", K.customers.window.hint, { min: RENEWAL_WINDOW_DAYS.min, max: RENEWAL_WINDOW_DAYS.max }),
            save: t("common", K.customers.window.save),
            saved: (days) => t("common", K.customers.window.saved, { days }),
          }}
          onSaved={setting.onSaved}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <BuyersCard x={x} fresh={customers?.buyers.newBuyers ?? []} returning={customers?.buyers.returningBuyers ?? []} loading={!customers} stale={stale} />

        <ChartCard<{ x: string; value: number | null }>
          title={t("common", C.signupsTrend)}
          subtitle={t("common", C.signupsSubtitle)}
          state={signups && signups.total === 0 ? "empty" : state}
          stale={stale}
          table={{
            columns: [
              { id: "x", header: t("common", K.table.date), cell: (r) => r.x },
              { id: "value", header: t("common", C.signups), cell: (r) => (r.value === null ? hidden : fmt.full(r.value)), dir: "ltr" },
            ],
            rows: x.map((label, i) => ({ x: label, value: signups?.series[i] ?? null })),
            rowKey: (r) => r.x,
          }}
        >
          <TrendChart label={t("common", C.signupsTrend)} x={x} series={[{ id: "signups", label: t("common", C.signups), values: signups?.series ?? [] }]} variant="area" formatValue={fmt.full} />
        </ChartCard>
      </div>

      <ChartCard<(typeof sources)[number]>
        title={t("common", C.bySource)}
        subtitle={hiddenSources > 0 ? t("common", K.byProduct.hidden, { count: fmt.full(hiddenSources) }) : t("common", C.bySourceSubtitle)}
        state={signups && sources.length === 0 ? "empty" : state}
        stale={stale}
        table={{
          columns: [
            { id: "label", header: t("common", C.source), cell: (r) => r.label },
            { id: "value", header: t("common", C.signups), cell: (r) => r.display, dir: "ltr" },
          ],
          rows: sources,
          rowKey: (r) => r.id,
        }}
      >
        <BarList label={t("common", C.bySource)} items={sources} formatValue={fmt.full} />
      </ChartCard>

      <RenewalByProduct rows={customers?.renewalByProduct ?? []} productName={productName} />
      {customers?.topCustomers && <TopCustomers rows={customers.topCustomers} currency={currency} userHref={userHref} />}
    </div>
  );

}

/** A rate as a percent, or a dash before anything could be judged. */
function useRate() {
  const fmt = useChartFormat();
  return (r: number | null) => (r === null ? "—" : fmt.percent(r));
}

function RenewalByProduct({ rows, productName }: { rows: readonly ProductRow[]; productName: CustomersTabProps["productName"] }) {
  const { t } = useLocale();
  const fmt = useChartFormat();
  const rate = useRate();
  const hidden = t("common", K.catalog.fewerThan5);
  const figure = (pick: (row: { productId: string | null } & RenewalFigures) => string) => (row: ProductRow) => (isShownProduct(row) ? pick(row) : hidden);
  const columns: DataColumn<ProductRow>[] = [
    { id: "product", header: t("common", K.table.product), cell: (row) => productName(row.productId) ?? t("common", K.byProduct.unnamed) },
    { id: "rate", header: t("common", C.renewalRate), cell: figure((row) => rate(row.rate)), dir: "ltr" },
    { id: "renewed", header: t("common", C.renewed), cell: figure((row) => fmt.full(row.renewed)), dir: "ltr" },
    { id: "lapsed", header: t("common", C.lapsed), cell: figure((row) => fmt.full(row.lapsed)), dir: "ltr" },
    { id: "pending", header: t("common", C.pending), cell: figure((row) => fmt.full(row.pending)), dir: "ltr" },
  ];
  return (
    <Card padding="sm">
      <CardHeader title={t("common", C.renewalByProduct)} className="mb-2" />
      <DataTable label={t("common", C.renewalByProduct)} rows={rows} columns={columns} rowKey={(row) => row.productId ?? "none"} empty={<p className="p-4 text-sm text-text-secondary">{t("common", C.noEnded)}</p>} compact bare />
    </Card>
  );
}

function TopCustomers({ rows, currency, userHref }: { rows: readonly Customer[]; currency: string; userHref: CustomersTabProps["userHref"] }) {
  const { t, lang } = useLocale();
  const fmt = useChartFormat();
  const nameOf = (row: Customer) => row.name ?? t("common", C.top.unnamed);
  const columns: DataColumn<Customer>[] = [
    { id: "name", header: t("common", C.top.customer), cell: (row) => (userHref ? <Link href={userHref(row.userId)} className="font-semibold text-primary hover:underline">{nameOf(row)}</Link> : nameOf(row)) },
    { id: "net", header: t("common", K.catalog.net), cell: (row) => formatMoney(amountIn(row.net, currency) ?? 0, currency, { lang, t }), dir: "ltr" },
    { id: "orders", header: t("common", K.catalog.orders), cell: (row) => fmt.full(row.orders), dir: "ltr" },
  ];
  return (
    <Card padding="sm">
      <CardHeader title={t("common", C.top.title)} className="mb-2" />
      <DataTable label={t("common", C.top.title)} rows={rows} columns={columns} rowKey={(row) => row.userId} empty={<p className="p-4 text-sm text-text-secondary">{t("common", K.catalog.empty)}</p>} compact bare />
    </Card>
  );
}
