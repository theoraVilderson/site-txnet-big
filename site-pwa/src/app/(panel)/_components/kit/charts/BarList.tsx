"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Tooltip } from "../Tooltip";
import { useChartFormat } from "./format";
import { CHART_OTHER } from "./palette";
import { useChartTheme } from "./useChartTheme";

const K = FrontendI18nKeys.common.kit.chart;

/** The list's length before the rest fold into Other (rule 3: a ninth hue never exists). */
export const BAR_LIST_TOP = 7;

export interface BarItem {
  id: string;
  label: string;
  value: number;
  /** The value as the page writes it — money in its currency; the reader's number format otherwise. */
  display?: string;
  /** The entity's slot colour (`slotsByEntity`); the main colour otherwise. */
  color?: string;
}

export interface BarListProps {
  /** The accessible name. */
  label: string;
  items: readonly BarItem[];
  /** How Other's folded value is written. Default: the reader's number format. */
  formatValue?: (n: number) => string;
  /** Other already folded by the server (billing's top 7 + `other`): drawn as Other, nothing folded again. */
  other?: number | null;
}

/** Largest first, the first seven, then everything else — and any `folded` remainder — as one neutral Other. */
export function barRows(items: readonly BarItem[], otherLabel: string, folded: number | null = null): (BarItem & { other?: true })[] {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const rest = sorted.slice(BAR_LIST_TOP);
  if (rest.length === 0 && folded === null) return sorted;
  const value = rest.reduce((n, r) => n + r.value, folded ?? 0);
  return [...sorted.slice(0, BAR_LIST_TOP), { id: "other", label: otherLabel, value, color: CHART_OTHER, other: true }];
}

/**
 * Horizontal bars, sorted, top 7 + Other, each with its value and share as
 * labels (F-1001-c) — the share is of the whole list, Other included.
 */
export function BarList({ label, items, formatValue, other = null }: BarListProps) {
  const { t } = useLocale();
  const { main } = useChartTheme();
  const fmt = useChartFormat();
  const rows = barRows(items, t("common", K.other), other);
  const total = rows.reduce((n, r) => n + Math.max(0, r.value), 0);
  const max = Math.max(0, ...rows.map((r) => r.value));

  return (
    <ul aria-label={label} className="space-y-2">
      {rows.map((row) => {
        const share = total > 0 ? Math.max(0, row.value) / total : 0;
        const shown = row.other ? (formatValue ?? fmt.full)(row.value) : (row.display ?? (formatValue ?? fmt.full)(row.value));
        return (
          <li key={row.id}>
            <Tooltip content={`${row.label}: ${shown} · ${fmt.percent(share)}`}>
              <div tabIndex={0} className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                  <span className="truncate text-text-primary">{row.label}</span>
                  <span className="shrink-0 tabular-nums text-text-secondary">
                    <span className="font-semibold text-text-primary">{shown}</span> · {fmt.percent(share)}
                  </span>
                </div>
                <div className="h-2.5 w-full">
                  <div className="h-full rounded-[4px] transition-[width] duration-300" style={{ width: `${max > 0 ? (Math.max(0, row.value) / max) * 100 : 0}%`, background: row.color ?? main }} />
                </div>
              </div>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
