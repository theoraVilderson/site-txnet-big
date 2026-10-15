// codeshape: spec-only — the kit lands a row before its first page (/analytics, F-1001-d); charts.test imports it until then
/**
 * The chart kit (F-1001-c, panel-web `contract.analytics.md` "Chart kit"), on
 * visx. A page that draws a chart uses these and no other library. Imported
 * from here, not from the kit's index, so only the routes that draw charts
 * load visx.
 */
export { BarList, BAR_LIST_TOP, type BarItem, type BarListProps } from "./BarList";
export { CalendarHeatmap, type CalendarHeatmapProps, type HeatDay } from "./CalendarHeatmap";
export { ChartCard, type ChartCardProps, type ChartTable, type LegendItem } from "./ChartCard";
export { DeltaPill, type ChartDelta, type DeltaPillProps } from "./DeltaPill";
export { useChartFormat, type ChartFormat } from "./format";
export { Meter, type MeterProps } from "./Meter";
export { CHART_OTHER, CHART_SLOTS, slotColor, slotsByEntity } from "./palette";
export { StackedColumns, type StackedColumnsProps, type StackSeries } from "./StackedColumns";
export { StatTile, type StatTileProps } from "./StatTile";
export { TrendChart, type TrendChartProps, type TrendSeries } from "./TrendChart";
export { useChartTheme, type ChartTheme } from "./useChartTheme";
