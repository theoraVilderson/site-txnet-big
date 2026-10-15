"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useBrandColor } from "@/context/BrandContext";
import { useTheme } from "@/context/ThemeContext";
import { type ChartMode, passesBrandCheck, sequentialScale } from "./color";
import { CHART_GRID, CHART_MUTED, CHART_OTHER } from "./palette";

/** The theme's own accent: what the main series falls back to (a brand never overrides this token). */
const THEME_ACCENT = "var(--chart-accent)";

export interface ChartTheme {
  mode: ChartMode;
  /** The main series: the brand if it passes the check on this theme's card surface, else the theme's accent. */
  main: string;
  /** The main series' hue in five steps from the surface, for the heatmap and the cohort grid. */
  sequential: string[];
  other: string;
  muted: string;
  grid: string;
}

/** The card surface the theme's tokens name, as the browser computed it. */
const readSurface = () => getComputedStyle(document.documentElement).getPropertyValue("--chart-surface").trim();

/** A theme switch or a brand override lands on <html>'s attributes; listen there. */
function onRootStyle(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
  return () => observer.disconnect();
}

/**
 * The chart colours for the current theme and brand (F-1001-c). The check runs
 * once per theme and brand, against the surface the theme's tokens name — read
 * from the page once it is styled, so a server render draws the theme's accent
 * and switches only if the brand passes.
 */
export function useChartTheme(): ChartTheme {
  const { theme } = useTheme();
  const brand = useBrandColor();
  const mode: ChartMode = theme === "light" ? "light" : "dark";
  const surface = useSyncExternalStore(onRootStyle, readSurface, () => "");

  return useMemo(() => {
    const main = brand && passesBrandCheck(brand, surface, mode) ? brand : THEME_ACCENT;
    return { mode, main, sequential: sequentialScale(main), other: CHART_OTHER, muted: CHART_MUTED, grid: CHART_GRID };
  }, [brand, surface, mode]);
}
