"use client";

import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { scaleBand } from "@visx/scale";
import { Bar } from "@visx/shape";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useChartFormat } from "./format";
import { ChartTooltip, useChartPointer } from "./interaction";
import { slotColor } from "./palette";
import { END_LABEL_ROOM, MARGIN, xTickIndexes, yScaleOf, yTicks } from "./plot";
import { useChartTheme } from "./useChartTheme";

const K = FrontendI18nKeys.common.kit.chart;

/** At most this many parts per column (rule 5). */
export const STACK_MAX_SERIES = 4;
/** The surface gap between stacked segments and between columns (rule 7). */
const GAP = 2;
/** A column's rounded top (rule 7). */
const RADIUS = 4;

export interface StackSeries {
  id: string;
  label: string;
  /** One non-negative value per column. */
  values: readonly number[];
  color?: string;
}

export interface StackedColumnsProps {
  label: string;
  x: readonly string[];
  series: readonly StackSeries[];
  height?: number;
  formatValue?: (n: number) => string;
  formatTick?: (n: number) => string;
}

/** Each part's [from, to] in one column, stacked from 0 in series order; a part of 0 or less is empty. */
export function stacked(series: readonly StackSeries[], col: number): { from: number; to: number }[] {
  const ends = series.map((s) => Math.max(0, s.values[col] ?? 0)).reduce<number[]>((acc, v) => [...acc, (acc.at(-1) ?? 0) + v], []);
  return ends.map((to, i) => ({ from: i === 0 ? 0 : ends[i - 1], to }));
}

/** Parts of a whole per bucket, up to four, stacked from 0 (F-1001-c). */
export function StackedColumns(props: StackedColumnsProps) {
  return (
    <div dir="ltr" className="relative w-full" style={{ height: props.height ?? 220 }}>
      <ParentSize debounceTime={50}>{({ width, height }) => (width > 0 ? <StackPlot {...props} width={width} height={height} /> : null)}</ParentSize>
    </div>
  );
}

function StackPlot({ label, x, series, width, height, formatValue, formatTick }: StackedColumnsProps & { width: number; height: number }) {
  const { t } = useLocale();
  const theme = useChartTheme();
  const fmt = useChartFormat();
  const shown = series.slice(0, STACK_MAX_SERIES);
  const colorOf = (s: StackSeries, i: number) => s.color ?? slotColor(i);
  const labelled = shown.length >= 2;

  const innerWidth = Math.max(0, width - MARGIN.start - MARGIN.end - (labelled ? END_LABEL_ROOM : 0));
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const totals = x.map((_, i) => shown.reduce((n, s) => n + Math.max(0, s.values[i] ?? 0), 0));
  const xScale = scaleBand<number>({ domain: x.map((_, i) => i), range: [0, innerWidth], paddingInner: 0.2, paddingOuter: 0.1 });
  const yScale = yScaleOf(totals, innerHeight);
  const pointer = useChartPointer(x.length, (px) => {
    const step = xScale.step();
    return step > 0 ? Math.min(x.length - 1, Math.max(0, Math.floor((px - MARGIN.start) / step))) : null;
  });
  const active = pointer.active;
  const value = formatValue ?? fmt.full;

  return (
    <>
      <svg width={width} height={height} role="img" aria-label={t("common", K.chart, { title: label })} tabIndex={0} className="touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg" onKeyDown={pointer.onKeyDown} onBlur={pointer.onBlur}>
        <Group left={MARGIN.start} top={MARGIN.top}>
          <GridRows scale={yScale} width={innerWidth} tickValues={yTicks(yScale)} stroke={theme.grid} />
          {x.map((_, col) => {
            const parts = stacked(shown, col);
            const top = parts.reduce((last, p, i) => (p.to > p.from ? i : last), -1);
            return (
              <g key={x[col]} opacity={active === null || active === col ? 1 : 0.6}>
                {shown.map((s, i) => {
                  const { from, to } = parts[i];
                  if (to <= from) return null;
                  // The gap comes off each segment's top; only the top segment is rounded (rule 7).
                  const h = Math.max(0, yScale(from) - yScale(to) - (i === top ? 0 : GAP));
                  return <Bar key={s.id} x={xScale(col) ?? 0} y={yScale(from) - h} width={xScale.bandwidth()} height={h} rx={i === top ? RADIUS : 0} fill={colorOf(s, i)} />;
                })}
              </g>
            );
          })}
          {labelled && x.length > 0 && <StackEndLabels series={shown} last={x.length - 1} x={(xScale(x.length - 1) ?? 0) + xScale.bandwidth()} y={yScale} />}
          <AxisLeft scale={yScale} tickValues={yTicks(yScale)} tickFormat={(v) => (formatTick ?? fmt.compact)(Number(v))} hideAxisLine hideTicks tickLabelProps={{ fill: "var(--text-label)", fontSize: 11 }} />
          <AxisBottom top={innerHeight} scale={xScale} tickValues={xTickIndexes(x.length, innerWidth)} tickFormat={(v) => x[Number(v)] ?? ""} hideTicks stroke={theme.grid} tickLabelProps={{ fill: "var(--text-label)", fontSize: 11 }} />
          <rect width={innerWidth} height={innerHeight} fill="transparent" onPointerMove={pointer.onPointerMove} onPointerLeave={pointer.onPointerLeave} onPointerDown={pointer.onPointerDown} />
        </Group>
      </svg>
      {active !== null && (
        <ChartTooltip
          x={MARGIN.start + (xScale(active) ?? 0) + xScale.bandwidth() / 2}
          y={MARGIN.top + yScale(totals[active] ?? 0)}
          width={width}
          title={x[active] ?? ""}
          rows={shown.map((s, i) => ({ id: s.id, label: s.label, value: value(s.values[active] ?? 0), color: colorOf(s, i) }))}
        />
      )}
    </>
  );
}

/** Each part's name beside its segment of the last column, in text ink (rule 5). */
function StackEndLabels({ series, last, x, y }: { series: readonly StackSeries[]; last: number; x: number; y: (v: number) => number }) {
  const parts = stacked(series, last);
  return (
    <>
      {series.map((s, i) =>
        parts[i].to <= parts[i].from ? null : (
          <text key={s.id} x={x + 6} y={y((parts[i].from + parts[i].to) / 2)} dy="0.32em" fontSize={11} fill="var(--text-secondary)">
            {s.label}
          </text>
        ),
      )}
    </>
  );
}
