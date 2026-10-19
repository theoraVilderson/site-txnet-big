"use client";

import { Gauge, Package, Receipt, Repeat, TrendingUp, Users, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { SegmentedControl, Select, TabLinks } from "../../_components/kit";
import { type AnalyticsFilters, type PageTab, TAB_VIEWS, groupOf } from "../_lib/filters";

const K = FrontendI18nKeys.common.analytics;

/** One icon per view, so the switch reads as a choice of pages and not as a filter. */
const VIEW_ICONS: Readonly<Partial<Record<PageTab, LucideIcon>>> = { customers: Users, cohorts: Repeat, catalog: Package, capacity: Gauge, margin: TrendingUp, expenses: Receipt };
/** What each view answers, said under the switch. */
const VIEW_HINTS: Readonly<Partial<Record<PageTab, string>>> = K.viewHints;

export interface AnalyticsTabsProps {
  filters: AnalyticsFilters;
  /** The row's tabs this viewer may open (`ROW_TABS`, Resellers for the owner only). */
  tabs: readonly PageTab[];
  /** Whether this viewer may open a tab or a view: a view it may not is not offered (F-1001-u). */
  offered: (tab: PageTab) => boolean;
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
export function AnalyticsTabs({ filters, tabs, offered, hrefOf, onOpen }: AnalyticsTabsProps) {
  const { t } = useLocale();
  const group = groupOf(filters.tab);
  // A group left with one view has no switch.
  const views = TAB_VIEWS[group]?.filter(offered);
  const hint = VIEW_HINTS[filters.tab];

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
      {views && views.length > 1 && (
        <div className="flex flex-col gap-1.5">
          {/* A small pill was missed and Retention read as gone (2026-10-17): full width on a phone, with icons and a line. */}
          <SegmentedControl
            ariaLabel={t("common", K.tabs[group])}
            value={filters.tab}
            onChange={onOpen}
            options={views.map((view) => ({ value: view, label: t("common", K.tabs[view]), icon: VIEW_ICONS[view] }))}
            className="grid w-full auto-cols-fr grid-flow-col sm:inline-flex sm:w-fit"
          />
          {hint && <p className="text-xs text-text-secondary">{t("common", hint)}</p>}
        </div>
      )}
    </>
  );
}
