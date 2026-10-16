"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { SegmentedControl, Select, TabLinks } from "../../_components/kit";
import { type AnalyticsFilters, type PageTab, TAB_VIEWS, groupOf } from "../_lib/filters";

const K = FrontendI18nKeys.common.analytics;

export interface AnalyticsTabsProps {
  filters: AnalyticsFilters;
  /** The row's tabs this viewer may open (`ROW_TABS`, Resellers for the owner only). */
  tabs: readonly PageTab[];
  hrefOf: (next: AnalyticsFilters) => string;
  /** Opens a tab or a view with the filters kept. */
  onOpen: (tab: PageTab) => void;
}

/**
 * The tabs of `/analytics` (panel-web `contract.analytics.md` "Tabs"): a row
 * that wraps from `md`, one picker below it — a scrolling row hid the rest
 * past a phone's edge — and, under a tab with views (`TAB_VIEWS`), a switch
 * between them.
 */
export function AnalyticsTabs({ filters, tabs, hrefOf, onOpen }: AnalyticsTabsProps) {
  const { t } = useLocale();
  const group = groupOf(filters.tab);
  const views = TAB_VIEWS[group];

  return (
    <>
      <Select
        ariaLabel={t("common", K.section)}
        value={group}
        onChange={(v) => {
          const tab = tabs.find((x) => x === v);
          if (tab) onOpen(tab);
        }}
        options={tabs.map((tab) => ({ value: tab, label: t("common", K.tabs[tab]) }))}
        className="md:hidden"
      />
      <TabLinks
        ariaLabel={t("common", K.title)}
        current={hrefOf({ ...filters, tab: group })}
        links={tabs.map((tab) => ({ href: hrefOf({ ...filters, tab }), label: t("common", K.tabs[tab]) }))}
        className="hidden flex-wrap md:flex"
      />
      {views && (
        <SegmentedControl
          size="sm"
          ariaLabel={t("common", K.tabs[group])}
          value={filters.tab}
          onChange={onOpen}
          options={views.map((view) => ({ value: view, label: t("common", K.tabs[view]) }))}
          className="w-fit"
        />
      )}
    </>
  );
}
