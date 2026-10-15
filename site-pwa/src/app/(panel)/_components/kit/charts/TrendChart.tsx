"use client";

import { AxisBottom, AxisLeft } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { GridRows } from "@visx/grid";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { AreaClosed, Line, LinePath } from "@visx/shape";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DeltaPill } from "./DeltaPill";
import { useChartFormat } from "./format";
import { ChartTooltip, type TooltipRow, useChartPointer } from "./interaction";
import { CHART_MUTED, PREVIOUS_DASH, slotColor } from "./palette";
import { END_LABEL_ROOM, MARGIN, finite, xTickIndexes, yScaleOf, yTicks } from "./plot";
import { useChartTheme } from "./useChartTheme";

const K = FrontendI18nKeys.common.kit.chart;

/** At most this many series on one chart (rule 5): more is a different chart. */
export const TREND_MAX_SERIES = 4;

export interface TrendSeries {
  id: string;
  label: string;
  values: readonly (number | null)[];
  /** The entity's slot colour (`slotsByEntity`); a lone series without one is the main colour. */
  color?: string;
}

export interface TrendChartProps {
  /** The accessible name. */
  label: string;
  /** One label per point, as the page writes a date in its calendar. */
  x: readonly string[];
  series: readonly TrendSeries[];
  /** The previous period under a single series, aligned by index (rule 2). */
  previous?: readonly (number | null)[];
  variant?: "line" | "area";
  height?: number;
  /** A full value, for the tooltip; an axis tick, compact. Default: the reader's number formats. */
  formatValue?: (n: number) => string;
  formatTick?: (n: number) => string;
}

type Point = { i: number; v: number };
const pointsOf = (values: readonly (number | null)[]): Point[] => values.flatMap((v, i) => (v === null ? [] : [{ i, v }]));

/** Line or area over time: one series and the previous period, or up to four series (F-1001-c). */
export function TrendChart(props: TrendChartProps) {
  return (
    <div dir="ltr" className="relative w-full" style={{ height: props.height ?? 220 }}>
      <ParentSize debounceTime={50}>{({ width, height }) => (width > 0 ? <TrendPlot {...props} width={width} height={height} /> : null)}</ParentSize>
    </div>
  );
}

function TrendPlot({ label, x, series, previous, variant = "line", width, height, formatValue, formatTick }: TrendChartProps & { width: number; height: number }) {
  const { t } = useLocale();
  const theme = useChartTheme();
  const fmt = useChartFormat();
  const level = useMotionLevel();
  const shown = series.slice(0, TREND_MAX_SERIES);
  const labelled = shown.length >= 2;
  const colorOf = (s: TrendSeries, i: number) => s.color ?? (shown.length === 1 ? theme.main : slotColor(i));
  const value = formatValue ?? fmt.full;

  const innerWidth = Math.max(0, width - MARGIN.start - MARGIN.end - (labelled ? END_LABEL_ROOM : 0));
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const xScale = scaleLinear<number>({ domain: [0, Math.max(1, x.length - 1)], range: [0, innerWidth] });
  const yScale = yScaleOf([...shown.flatMap((s) => finite(s.values)), ...finite(previous ?? [])], innerHeight);
  const pointer = useChartPointer(x.length, (px) => (x.length ? Math.round(xScale.invert(px - MARGIN.start)) : null));
  // A CSS animation runs when its element is inserted, not when its data
  // changes: the line draws once, then morphs (rule 10). Reduced: neither.
  const draws = level !== "reduced";

  const active = pointer.active;
  const rows: TooltipRow[] =
    active === null
      ? []
      : [
          ...shown.map((s, i) => ({ id: s.id, label: s.label, value: s.values[active] === null ? "—" : value(s.values[active] ?? 0), color: colorOf(s, i) })),
          ...(previous && shown.length === 1 ? [{ id: "previous", label: t("common", K.previous), value: previous[active] === null ? "—" : value(previous[active] ?? 0), color: CHART_MUTED, dashed: true }] : []),
        ];
  const now = active === null ? null : shown[0]?.values[active];
  const before = active === null ? null : previous?.[active];
  const delta = now == null || before == null ? null : before === 0 ? (now === 0 ? 0 : "new") : (now - before) / Math.abs(before);

  return (
    <>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={t("common", K.chart, { title: label })}
        tabIndex={0}
        className="touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg"
        onKeyDown={pointer.onKeyDown}
        onBlur={pointer.onBlur}
      >
        <Group left={MARGIN.start} top={MARGIN.top}>
          <GridRows scale={yScale} width={innerWidth} tickValues={yTicks(yScale)} stroke={theme.grid} />
          {previous && shown.length === 1 && (
            <LinePath data={pointsOf(previous)} x={(p) => xScale(p.i)} y={(p) => yScale(p.v)} curve={curveMonotoneX} stroke={CHART_MUTED} strokeWidth={2} strokeDasharray={PREVIOUS_DASH} />
          )}
          {shown.map((s, i) => (
            <g key={s.id}>
              {variant === "area" && (
                <AreaClosed data={pointsOf(s.values)} x={(p) => xScale(p.i)} y={(p) => yScale(p.v)} yScale={yScale} curve={curveMonotoneX} fill={colorOf(s, i)} fillOpacity={0.14} className={draws ? "chart-rise" : undefined} />
              )}
              <LinePath data={pointsOf(s.values)} x={(p) => xScale(p.i)} y={(p) => yScale(p.v)} curve={curveMonotoneX} stroke={colorOf(s, i)} strokeWidth={2} strokeLinecap="round" pathLength={draws ? 1 : undefined} className={draws ? "chart-draw chart-morph" : undefined} />
            </g>
          ))}
          {labelled && shown.map((s) => <EndLabel key={s.id} series={s} x={xScale} y={yScale} />)}
          {active !== null && (
            <>
              <Line from={{ x: xScale(active), y: 0 }} to={{ x: xScale(active), y: innerHeight }} stroke={theme.muted} strokeWidth={1} />
              {shown.map((s, i) => (s.values[active] === null ? null : <circle key={s.id} cx={xScale(active)} cy={yScale(s.values[active] ?? 0)} r={4} fill={colorOf(s, i)} stroke="var(--chart-surface)" strokeWidth={2} />))}
            </>
          )}
          <AxisLeft scale={yScale} tickValues={yTicks(yScale)} tickFormat={(v) => (formatTick ?? fmt.compact)(Number(v))} hideAxisLine hideTicks tickLabelProps={{ fill: "var(--text-label)", fontSize: 11 }} />
          <AxisBottom top={innerHeight} scale={xScale} tickValues={xTickIndexes(x.length, innerWidth)} tickFormat={(v) => x[Number(v)] ?? ""} hideTicks stroke={theme.grid} tickLabelProps={{ fill: "var(--text-label)", fontSize: 11 }} />
          {/* The hit target: the whole plot, so a point is never a 4px aim (rule 9). */}
          <rect width={innerWidth} height={innerHeight} fill="transparent" onPointerMove={pointer.onPointerMove} onPointerLeave={pointer.onPointerLeave} onPointerDown={pointer.onPointerDown} />
        </Group>
      </svg>
      {active !== null && (
        <ChartTooltip x={MARGIN.start + xScale(active)} y={MARGIN.top + yScale(now ?? 0)} width={width} title={x[active] ?? ""} rows={rows} extra={previous && shown.length === 1 ? <DeltaPill delta={delta} bare /> : undefined} />
      )}
    </>
  );
}

/** A series' name at the end of its line, in text ink (never the series colour). */
function EndLabel({ series, x, y }: { series: TrendSeries; x: (i: number) => number; y: (v: number) => number }) {
  const last = pointsOf(series.values).at(-1);
  if (!last) return null;
  return (
    <text x={x(last.i) + 6} y={y(last.v)} dy="0.32em" fontSize={11} fill="var(--text-secondary)">
      {series.label}
    </text>
  );
}
