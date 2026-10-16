"use client";

import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ANALYTICS_COMPARES, type AnalyticsNames } from "@/lib/billing/analytics";
import { Button, SegmentedControl, Select, Sheet } from "../../_components/kit";
import { DatePicker } from "../../_components/kit/DatePicker";
import { type AnalyticsFilters, RANGE_PRESETS, type RangePreset, activeFilterCount } from "../_lib/filters";

const K = FrontendI18nKeys.common.analytics;

export interface FilterBarProps {
  filters: AnalyticsFilters;
  /** The window the filters resolve to now — where a switch to `custom` starts from. */
  window: { from: string; to: string };
  names: AnalyticsNames | null;
  productName: (id: string | null) => string | null;
  onChange: (next: Partial<AnalyticsFilters>) => void;
}

/** The fields themselves, laid out by the caller: one row from `md`, a column in the phone's sheet. */
function FilterFields({ filters, window, names, productName, onChange }: FilterBarProps) {
  const { t } = useLocale();
  const pickRange = (range: RangePreset) =>
    // Custom starts from the window on screen, so the URL always holds a readable range.
    onChange(range === "custom" ? { range, from: window.from, to: window.to } : { range, from: null, to: null });
  const products = names?.products ?? [];
  const panels = names?.panels ?? [];
  const kinds = names?.kinds ?? [];

  return (
    <>
      <Select
        ariaLabel={t("common", K.filters.range)}
        value={filters.range}
        onChange={(v) => pickRange(v as RangePreset)}
        options={RANGE_PRESETS.map((r) => ({ value: r, label: t("common", K.ranges[r]) }))}
        className="md:w-44"
      />
      {filters.range === "custom" && (
        <div className="flex gap-2">
          <DatePicker label={t("common", K.filters.from)} value={filters.from} onChange={(from) => from && onChange({ from })} />
          <DatePicker label={t("common", K.filters.to)} value={filters.to} onChange={(to) => to && onChange({ to })} />
        </div>
      )}
      <SegmentedControl
        size="sm"
        ariaLabel={t("common", K.filters.compare)}
        value={filters.compare}
        onChange={(compare) => onChange({ compare })}
        options={ANALYTICS_COMPARES.map((c) => ({ value: c, label: t("common", K.compares[c]) }))}
      />
      {/* One kind is no choice (ADR-0148 (3)); a kind that is on stays offered while the window holds two. */}
      {(kinds.length > 1 || filters.fulfilment) && (
        <Select
          ariaLabel={t("common", K.filters.kind)}
          value={filters.fulfilment ?? ""}
          onChange={(v) => onChange({ fulfilment: kinds.find((k) => k === v) ?? null })}
          options={[{ value: "", label: t("common", K.filters.allKinds) }, ...kinds.map((k) => ({ value: k, label: t("common", K.kinds[k]) }))]}
          className="md:w-44"
        />
      )}
      {products.length > 0 && (
        <Select
          ariaLabel={t("common", K.filters.product)}
          value={filters.product ?? ""}
          onChange={(v) => onChange({ product: v || null })}
          options={[{ value: "", label: t("common", K.filters.allProducts) }, ...products.map((p) => ({ value: p.id, label: productName(p.id) ?? t("common", K.byProduct.unnamed) }))]}
          className="md:w-48"
        />
      )}
      {panels.length > 0 && (
        <Select
          ariaLabel={t("common", K.filters.panel)}
          value={filters.panel ?? ""}
          onChange={(v) => onChange({ panel: v || null })}
          options={[{ value: "", label: t("common", K.filters.allPanels) }, ...panels.map((p) => ({ value: p.id, label: p.name }))]}
          className="md:w-44"
        />
      )}
    </>
  );
}

/**
 * The filter bar (F-1001-d, panel-web `contract.analytics.md` "Filter bar"):
 * sticky under the top bar, every value in the URL through `onChange`. Below
 * `md` it is one Filters button that opens a sheet and says how many are on.
 */
export function FilterBar(props: FilterBarProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(props.filters);
  const label = count > 0 ? `${t("common", K.filters.button)} (${count})` : t("common", K.filters.button);

  return (
    <div className="sticky top-24 z-10 -mx-1 rounded-2xl border border-card-border bg-card-bg/95 p-2 backdrop-blur-xl">
      <div className="hidden flex-wrap items-center gap-2 md:flex">
        <FilterFields {...props} />
      </div>
      <div className="md:hidden">
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          <SlidersHorizontal className="size-4" aria-hidden />
          {label}
        </Button>
        <Sheet open={open} onClose={() => setOpen(false)} title={t("common", K.filters.title)} footer={<Button onClick={() => setOpen(false)}>{t("common", K.filters.done)}</Button>}>
          <div className="flex flex-col gap-3">
            <FilterFields {...props} />
          </div>
        </Sheet>
      </div>
    </div>
  );
}
