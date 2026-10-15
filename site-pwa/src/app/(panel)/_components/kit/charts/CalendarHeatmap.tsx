"use client";

import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { MD_UP, useMediaQuery } from "../overlay";
import { SEQUENTIAL_STEPS } from "./color";
import { useChartFormat } from "./format";
import { ChartTooltip, useChartPointer } from "./interaction";
import { useChartTheme } from "./useChartTheme";

const K = FrontendI18nKeys.common.kit.chart;

/** Below `md` only the last this many weeks are drawn (rule 12). */
export const PHONE_WEEKS = 13;
const DAYS_PER_WEEK = 7;
/** The largest cell, and the gap between cells. */
const MAX_CELL = 16;
const GAP = 2;

export interface HeatDay {
  /** `YYYY-MM-DD`. */
  day: string;
  /** `null`: nothing to show — hidden or no figure — drawn as the empty cell. */
  value: number | null;
}

export interface CalendarHeatmapProps {
  label: string;
  /** Consecutive days, oldest first. */
  days: readonly HeatDay[];
  /** JS weekday a week starts on: 6 (Saturday) in the Jalali calendar, 1 (Monday) otherwise. */
  weekStartsOn: number;
  /** A day as the page writes it in its calendar. */
  formatDay: (day: string) => string;
  formatValue?: (n: number) => string;
}

/** Which of the five sequential steps a positive value falls in, by its share of the largest; `null` for none — the empty cell. */
export function heatStep(value: number | null, max: number): number | null {
  if (value === null || value <= 0 || max <= 0) return null;
  return Math.min(SEQUENTIAL_STEPS - 1, Math.floor((value / max) * SEQUENTIAL_STEPS));
}

/** Weeks as columns, oldest first; a day's row is its place in its week. The first week is padded at the top. */
export function weeksOf(days: readonly HeatDay[], weekStartsOn: number): { day: HeatDay; col: number; row: number }[] {
  if (days.length === 0) return [];
  const lead = (new Date(`${days[0].day}T12:00:00Z`).getUTCDay() - weekStartsOn + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  return days.map((day, i) => ({ day, col: Math.floor((i + lead) / DAYS_PER_WEEK), row: (i + lead) % DAYS_PER_WEEK }));
}

/** One cell per day in a single hue, weeks as columns — "when do we sell" at a glance (F-1001-c). */
export function CalendarHeatmap(props: CalendarHeatmapProps) {
  const wide = useMediaQuery(MD_UP);
  const days = wide ? props.days : props.days.slice(-PHONE_WEEKS * DAYS_PER_WEEK);
  return (
    <div dir="ltr" className="relative w-full">
      <ParentSize debounceTime={50}>{({ width }) => (width > 0 ? <HeatPlot {...props} days={days} width={width} /> : null)}</ParentSize>
    </div>
  );
}

function HeatPlot({ label, days, weekStartsOn, formatDay, formatValue, width }: CalendarHeatmapProps & { width: number }) {
  const { t, isRtl } = useLocale();
  const theme = useChartTheme();
  const fmt = useChartFormat();
  const cells = weeksOf(days, weekStartsOn);
  const weeks = (cells.at(-1)?.col ?? 0) + 1;
  const size = Math.max(4, Math.min(MAX_CELL, Math.floor(width / weeks) - GAP));
  const height = DAYS_PER_WEEK * (size + GAP);
  const max = Math.max(0, ...days.map((d) => d.value ?? 0));
  const pointer = useChartPointer(cells.length, (px, py) => {
    const col = Math.floor(px / (size + GAP));
    const row = Math.floor(py / (size + GAP));
    const i = cells.findIndex((c) => c.col === col && c.row === row);
    return i < 0 ? null : i;
  });
  const active = pointer.active === null ? null : cells[pointer.active];
  const fillOf = (step: number | null) => (step === null ? theme.grid : theme.sequential[step]);

  return (
    <>
      <svg width={width} height={height} role="img" aria-label={t("common", K.chart, { title: label })} tabIndex={0} className="block outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md" onKeyDown={pointer.onKeyDown} onBlur={pointer.onBlur} onPointerMove={pointer.onPointerMove} onPointerLeave={pointer.onPointerLeave} onPointerDown={pointer.onPointerDown}>
        <Group>
          {cells.map(({ day, col, row }) => (
            <rect
              key={day.day}
              x={col * (size + GAP)}
              y={row * (size + GAP)}
              width={size}
              height={size}
              rx={3}
              fill={fillOf(heatStep(day.value, max))}
              stroke={active?.day.day === day.day ? "var(--text-primary)" : undefined}
              strokeWidth={active?.day.day === day.day ? 1.5 : undefined}
            />
          ))}
        </Group>
      </svg>
      <div dir={isRtl ? "rtl" : "ltr"} className="mt-2 flex items-center justify-end gap-1 text-2xs text-text-label">
        <span>{t("common", K.less)}</span>
        {theme.sequential.map((color) => (
          <span key={color} aria-hidden className="inline-block size-3 rounded-[3px]" style={{ background: color }} />
        ))}
        <span>{t("common", K.more)}</span>
      </div>
      {active && (
        <ChartTooltip
          x={active.col * (size + GAP) + size}
          y={active.row * (size + GAP)}
          width={width}
          title={formatDay(active.day.day)}
          rows={[{ id: "value", label: label, value: active.day.value === null ? "—" : (formatValue ?? fmt.full)(active.day.value) }]}
        />
      )}
    </>
  );
}
