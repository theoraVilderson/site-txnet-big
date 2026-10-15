"use client";

import { useMemo } from "react";
import { useLocale } from "@/context/LocaleContext";
import { numberLocale } from "../../../_lib/digits";

/** How a chart writes a number when the page gives it no formatter. */
export interface ChartFormat {
  /** An axis tick: `1.2M` / `۱٫۲ میلیون`'s words with Latin digits (rule 8). */
  compact: (n: number) => string;
  /** A tooltip or a label: the whole figure. */
  full: (n: number) => string;
  /** A ratio as a percent with at most one decimal. */
  percent: (ratio: number) => string;
}

/** The reader's number formats, from the language's `numberLocale` (digits.ts). */
export function useChartFormat(): ChartFormat {
  const { lang } = useLocale();
  return useMemo(() => {
    const locale = numberLocale(lang);
    const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
    const full = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
    return { compact: (n) => compact.format(n), full: (n) => full.format(n), percent: (r) => percent.format(r) };
  }, [lang]);
}
