"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChartColumn } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ANALYTICS_TABS } from "@/lib/billing/analytics";
import { catalogApi } from "@/lib/catalog-api";
import { PANEL_ANALYTICS } from "@/lib/routes";
import { tenantChannelOf } from "@/lib/tenant-channel";
import { displayZone } from "@/lib/time-zone";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Alert, Button, PageHeader, SegmentedControl, TabLinks } from "../../_components/kit";
import { flattenTexts } from "../../catalog/_lib/catalog-form";
import { dayIn, formatInstant, formatRelative } from "../../_lib/datetime";
import { useAnalyticsRead } from "../_hooks/useAnalyticsRead";
import { type AnalyticsFilters, calendarOf, filtersOf, queryOf, searchOf, windowOf } from "../_lib/filters";
import { currencyOf, productNamer } from "../_lib/overview";
import { ExportMenu } from "./ExportMenu";
import { FilterBar } from "./FilterBar";
import { OverviewTab } from "./OverviewTab";

const K = FrontendI18nKeys.common.analytics;

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
 * reseller's workspace. Every filter is in the URL. It re-reads on
 * `billing.analytics.refreshed`, which reaches only a connection in that tenant
 * (realtime `contract.channels.md`), so a workspace view of another tenant
 * reads on load and on a filter change. Billing decides who may read
 * (`analytics.read`); a refusal is shown as its sentence.
 */
export function AnalyticsView({ tenantId: pathTenant }: { tenantId?: string } = {}) {
  const { t, lang } = useLocale();
  const errorText = useApiErrorMessage();
  const { me } = usePanelSession();
  const router = useRouter();
  const pathname = usePathname() ?? PANEL_ANALYTICS;
  const search = useSearchParams()?.toString() ?? "";

  const filters = useMemo(() => filtersOf(new URLSearchParams(search)), [search]);
  const calendar = calendarOf(lang);
  // The viewer's day, read once: a page left open past midnight keeps the window it opened with.
  const [today] = useState(() => dayIn(Date.now(), displayZone()));
  const query = useMemo(() => queryOf(filters, today, calendar), [filters, today, calendar]);
  const tenantId = pathTenant ?? me?.tenant.id ?? null;
  const channel = me && tenantId === me.tenant.id ? tenantChannelOf(me) : null;
  const { answer, stale, error, reload } = useAnalyticsRead(tenantId, filters.tab, query, channel);
  const texts = useCatalogTexts(lang);

  const hrefOf = (next: AnalyticsFilters) => {
    const s = searchOf(next);
    return s ? `${pathname}?${s}` : pathname;
  };
  const onChange = (next: Partial<AnalyticsFilters>) => router.replace(hrefOf({ ...filters, ...next }), { scroll: false });

  const ready = answer && !answer.rebuilding ? answer : null;
  const names = ready?.names ?? null;
  const productName = useMemo(() => productNamer(names ?? { products: [], panels: [] }, texts), [names, texts]);
  const currency = ready ? currencyOf(ready.currencies, filters.currency) : null;
  const formatDay = (day: string) => formatInstant(noonOf(day), lang, { withTime: false }) ?? day;
  const updated = answer?.refreshedAt ? t("common", K.updated, { ago: formatRelative(answer.refreshedAt, lang) ?? "" }) : t("common", K.notYetRolled);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <PageHeader
        icon={ChartColumn}
        title={t("common", K.title)}
        subtitle={answer ? updated : t("common", K.subtitle)}
        actions={<ExportMenu tenantId={tenantId} tab={filters.tab} query={query} />}
      />

      <FilterBar filters={filters} window={windowOf(filters, today, calendar)} names={names} productName={productName} onChange={onChange} />

      <TabLinks
        ariaLabel={t("common", K.title)}
        current={hrefOf(filters)}
        links={ANALYTICS_TABS.map((tab) => ({ href: hrefOf({ ...filters, tab }), label: t("common", K.tabs[tab]) }))}
      />

      {ready && ready.currencies.length > 1 && currency && (
        <Alert tone="info" title={t("common", K.severalCurrencies)}>
          <SegmentedControl size="sm" ariaLabel={t("common", K.filters.currency)} value={currency} onChange={(c) => onChange({ currency: c })} options={ready.currencies.map((c) => ({ value: c, label: c }))} />
        </Alert>
      )}
      {ready?.suppressed && <p className="text-xs text-text-secondary">{t("common", K.hiddenCells)}</p>}

      {answer?.rebuilding ? (
        <Alert tone="info" title={t("common", K.rebuilding.title)}>
          {t("common", K.rebuilding.body)}
        </Alert>
      ) : error && !answer ? (
        <Alert tone="error" title={t("common", K.loadFailed)} action={<Button size="sm" variant="secondary" onClick={reload}>{t("common", FrontendI18nKeys.common.kit.chart.retry)}</Button>}>
          {errorText(error)}
        </Alert>
      ) : (
        <OverviewTab
          overview={ready}
          names={names}
          x={(ready?.buckets ?? []).map(formatDay)}
          currency={currency ?? ""}
          calendar={calendar}
          formatDay={formatDay}
          productName={productName}
          stale={stale}
        />
      )}
    </div>
  );
}
