"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useBrandColor } from "@/context/BrandContext";
import { useTheme } from "@/context/ThemeContext";
import { type ChartMode, mainSeriesOf, sequentialScale } from "./color";
import { CHART_GRID, CHART_MUTED, CHART_OTHER } from "./palette";

export interface ChartTheme {
  mode: ChartMode;
  /** The main series: the brand, else the theme's accent, else slot 1 — the first that passes the check (`mainSeriesOf`). */
  main: string;
  /** The main series' hue in five steps from the surface, for the heatmap and the cohort grid. */
  sequential: string[];
  other: string;
  muted: string;
  grid: string;
}

/** The card surface and the theme's own accent, as the browser computed them — one string, so the snapshot is stable. */
const readTokens = () => {
  const style = getComputedStyle(document.documentElement);
  return `${style.getPropertyValue("--chart-surface").trim()} ${style.getPropertyValue("--chart-accent").trim()}`;
};

/** A theme switch or a brand override lands on <html>'s attributes; listen there. */
function onRootStyle(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
  return () => observer.disconnect();
}

/**
 * The chart colours for the current theme and brand (F-1001-c). The check runs
 * once per theme and brand, against the surface the theme's tokens name — read
 * from the page once it is styled; a server render draws the theme's accent.
 */
export function useChartTheme(): ChartTheme {
  const { theme } = useTheme();
  const brand = useBrandColor();
  const mode: ChartMode = theme === "light" ? "light" : "dark";
  const tokens = useSyncExternalStore(onRootStyle, readTokens, () => " ");

  return useMemo(() => {
    const [surface = "", accent = ""] = tokens.split(" ");
    const main = mainSeriesOf({ brand, accent, surface, mode });
    return { mode, main, sequential: sequentialScale(main), other: CHART_OTHER, muted: CHART_MUTED, grid: CHART_GRID };
  }, [brand, tokens, mode]);
}
