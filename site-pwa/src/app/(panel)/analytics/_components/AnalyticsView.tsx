"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChartColumn } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { AnalyticsNames } from "@/lib/billing/analytics";
import { catalogApi } from "@/lib/catalog-api";
import { PANEL_ANALYTICS, PANEL_SYSTEMS } from "@/lib/routes";
import { displayZone } from "@/lib/time-zone";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Alert, Button, PageHeader, SegmentedControl } from "../../_components/kit";
import { flattenTexts } from "../../catalog/_lib/catalog-form";
import { dayIn, formatInstant, formatMonth, formatRelative } from "../../_lib/datetime";
import { useAnalyticsRead } from "../_hooks/useAnalyticsRead";
import { type AnalyticsFilters, type PageTab, ROW_TABS, calendarOf, filtersOf, isFigureTab, queryOf, searchOf, windowOf } from "../_lib/filters";
import { customerHrefOf, settingsEditable } from "../_lib/customers";
import { analyticsLiveOf } from "../_lib/live";
import { resellersVisible } from "../_lib/resellers";
import { currencyOf, productNamer } from "../_lib/overview";
import { meterNamer } from "../_lib/usage";
import { AnalyticsTabs } from "./AnalyticsTabs";
import { ExportMenu } from "./ExportMenu";
import { FilterBar } from "./FilterBar";
import { CapacityTab } from "./CapacityTab";
import { CatalogTab } from "./CatalogTab";
import { CohortsTab } from "./CohortsTab";
import { CustomersTab } from "./CustomersTab";
import { ResellersTab } from "./ResellersTab";
import { OverviewTab } from "./OverviewTab";
import { ProfitTab } from "./ProfitTab";
import { ReportsTab } from "./ReportsTab";
import { SalesTab } from "./SalesTab";

const K = FrontendI18nKeys.common.analytics;

/** The tabs whose answer on the platform's own view moves with any reseller's pass: the leaderboard, and margin per reseller (F-1001-m). */
const READS_EVERY_RESELLER: ReadonlySet<string> = new Set(["resellers", "margin"]);

/** Before the first answer: nothing to name. */
const NO_NAMES: AnalyticsNames = { products: [], panels: [], meters: [], kinds: [] };

/** A tenant day at noon UTC, so the label is that day on every wall clock from UTC-11 to UTC+11. */
const noonOf = (day: string) => `${day}T12:00:00Z`;

/** The published catalog words in the reader's language (the namespace every product's `nameKey` is in). */
function useCatalogTexts(lang: string): Record<string, string> {
  const [texts, setTexts] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    catalogApi
      .texts(lang)
      .then((nested) => live && setTexts(flattenTexts(nested)))
      // No words is a page of "unnamed" products, never a failed page.
      .catch(() => live && setTexts({}));
    return () => {
      live = false;
    };
  }, [lang]);
  return texts;
}

/**
 * `/analytics` (F-1001-d, panel-web `contract.analytics.md` "The page"): the
 * header with "updated N min ago" and the Export menu (F-1007-b), the sticky filter bar, the tabs and the
 * open tab — for the session's tenant, or the path's (`tenantId`) on a
 * reseller's workspace. Every filter is in the URL. It re-reads live on its
 * tenant's rollup event, on the channels `analyticsLiveOf` names — a
 * workspace view on its owner's and the platform's (F-1001-p); `self` is a reseller's
 * owner on its own workspace (F-1001-g, who may set its renewal window). Billing decides who may read
 * (`analytics.read`); a refusal is shown as its sentence.
 */
export function AnalyticsView({ tenantId: pathTenant, self }: { tenantId?: string; self?: boolean } = {}) {
  const { t, lang } = useLocale();
  const errorText = useApiErrorMessage();
  const { me } = usePanelSession();
  const router = useRouter();
  const pathname = usePathname() ?? PANEL_ANALYTICS;
  const search = useSearchParams()?.toString() ?? "";

  const asked = useMemo(() => filtersOf(new URLSearchParams(search)), [search]);
  // The leaderboard is the platform's own view, for its report key (F-1001-i): anyone else asking for it lands on the Overview.
  const owner = resellersVisible(me, pathTenant);
  const filters = useMemo(() => (asked.tab === "resellers" && !owner ? { ...asked, tab: "overview" as const } : asked), [asked, owner]);
  const tabs = ROW_TABS.filter((tab) => tab !== "resellers" || owner);
  // Reports reads schedules, never a figure (F-1006-b).
  const figureTab = isFigureTab(filters.tab) ? filters.tab : null;
  const calendar = calendarOf(lang);
  // The viewer's day, read once: a page left open past midnight keeps the window it opened with.
  const [today] = useState(() => dayIn(Date.now(), displayZone()));
  const query = useMemo(() => queryOf(filters, today, calendar), [filters, today, calendar]);
  const tenantId = pathTenant ?? me?.tenant.id ?? null;
  const { answer, stale, error, reload } = useAnalyticsRead(figureTab ? tenantId : null, figureTab ?? "overview", query, analyticsLiveOf(me, figureTab ? tenantId : null, { everyReseller: READS_EVERY_RESELLER.has(filters.tab) }));
  // The Overview's top five (F-1001-i): the same window, read beside it and live on any reseller's pass.
  const top = useAnalyticsRead(owner && filters.tab === "overview" ? tenantId : null, "resellers", query, analyticsLiveOf(me, owner ? tenantId : null, { everyReseller: true }));
  const texts = useCatalogTexts(lang);

  const hrefOf = (next: AnalyticsFilters) => {
    const s = searchOf(next);
    return s ? `${pathname}?${s}` : pathname;
  };
  const onChange = (next: Partial<AnalyticsFilters>) => router.replace(hrefOf({ ...filters, ...next }), { scroll: false });
  // A tab is a place to go back to, as a link is: pushed, where a filter replaces.
  const openTab = (tab: PageTab) => router.push(hrefOf({ ...filters, tab }), { scroll: false });

  // The settings key's holders may change what the figures are judged by (billing's door decides).
  const setting = tenantId && settingsEditable(me, { tenantId: pathTenant, self }) ? { tenantId, onSaved: reload } : null;
  const ready = figureTab && answer && !answer.rebuilding ? answer : null;
  // The hook keeps the last answer while the next loads: one for another tab is no figure of this one.
  const body = ready?.tab === filters.tab ? ready : null;
  const names = ready?.names ?? null;
  const productName = useMemo(() => productNamer(names ?? NO_NAMES, texts), [names, texts]);
  const meterName = useMemo(() => meterNamer(names ?? NO_NAMES, texts, t), [names, texts, t]);
  const panelName = (id: string | null) => names?.panels.find((p) => p.id === id)?.name ?? null;
  const viewOf = (patch: Partial<AnalyticsFilters>) => hrefOf({ ...filters, ...patch });
  const currency = ready ? currencyOf(ready.currencies, filters.currency) : null;
  const formatDay = (day: string) => formatInstant(noonOf(day), lang, { withTime: false }) ?? day;
  const x = (body?.buckets ?? []).map(formatDay);
  const updated = answer?.refreshedAt ? t("common", K.updated, { ago: formatRelative(answer.refreshedAt, lang) ?? "" }) : t("common", K.notYetRolled);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <PageHeader
        icon={ChartColumn}
        title={t("common", K.title)}
        subtitle={answer ? updated : t("common", K.subtitle)}
        actions={figureTab && <ExportMenu tenantId={tenantId} tab={figureTab} query={query} />}
      />

      <FilterBar filters={filters} window={windowOf(filters, today, calendar)} names={names} productName={productName} onChange={onChange} />

      <AnalyticsTabs filters={filters} tabs={tabs} hrefOf={hrefOf} onOpen={openTab} />

      {ready && ready.currencies.length > 1 && currency && (
        <Alert tone="info" title={t("common", K.severalCurrencies)}>
          <SegmentedControl size="sm" ariaLabel={t("common", K.filters.currency)} value={currency} onChange={(c) => onChange({ currency: c })} options={ready.currencies.map((c) => ({ value: c, label: c }))} />
        </Alert>
      )}
      {ready?.suppressed && <p className="text-xs text-text-secondary">{t("common", K.hiddenCells)}</p>}

      {filters.tab === "reports" ? (
        tenantId && <ReportsTab tenantId={tenantId} calendar={calendar} tabName={(tab) => t("common", K.tabs[tab])} />
      ) : answer?.rebuilding ? (
        <Alert tone="info" title={t("common", K.rebuilding.title)}>
          {t("common", K.rebuilding.body)}
        </Alert>
      ) : error && !answer ? (
        <Alert tone="error" title={t("common", K.loadFailed)} action={<Button size="sm" variant="secondary" onClick={reload}>{t("common", FrontendI18nKeys.common.kit.chart.retry)}</Button>}>
          {errorText(error)}
        </Alert>
      ) : filters.tab === "sales" ? (
        <SalesTab sales={body?.tab === "sales" ? body : null} x={x} currency={currency ?? ""} productName={productName} stale={stale} />
      ) : filters.tab === "customers" ? (
        <CustomersTab
          customers={body?.tab === "customers" ? body : null}
          x={x}
          currency={currency ?? ""}
          productName={productName}
          userHref={customerHrefOf({ tenantId: pathTenant, self })}
          setting={setting}
          stale={stale}
        />
      ) : filters.tab === "cohorts" ? (
        <CohortsTab cohorts={body?.tab === "cohorts" ? body : null} currency={currency ?? ""} formatMonth={(day) => formatMonth(day, lang)} stale={stale} />
      ) : filters.tab === "capacity" ? (
        <CapacityTab capacity={body?.tab === "capacity" ? body : null} currency={currency ?? ""} formatDay={formatDay} systemsHref={owner ? PANEL_SYSTEMS : null} stale={stale} />
      ) : filters.tab === "margin" ? (
        <ProfitTab
          margin={body?.tab === "margin" ? body : null}
          x={x}
          currency={currency ?? ""}
          productName={productName}
          panelName={panelName}
          userHref={customerHrefOf({ tenantId: pathTenant, self })}
          setting={setting}
          stale={stale}
        />
      ) : filters.tab === "resellers" ? (
        <ResellersTab resellers={body?.tab === "resellers" ? body : null} currency={currency ?? ""} />
      ) : filters.tab === "catalog" ? (
        <CatalogTab catalog={body?.tab === "catalog" ? body : null} currency={currency ?? ""} productName={productName} panelName={panelName} hrefOf={viewOf} />
      ) : (
        <OverviewTab
          overview={body?.tab === "overview" ? body : null}
          names={names}
          x={x}
          currency={currency ?? ""}
          calendar={calendar}
          formatDay={formatDay}
          productName={productName}
          meterName={meterName}
          hrefOf={viewOf}
          topResellers={top.answer && !top.answer.rebuilding ? top.answer : null}
          stale={stale}
        />
      )}
    </div>
  );
}
