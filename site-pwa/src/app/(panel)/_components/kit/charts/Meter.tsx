"use client";

import { cn } from "../cn";
import { useChartFormat } from "./format";
import { useChartTheme } from "./useChartTheme";

export interface MeterProps {
  /** The ratio, 0..1; anything outside is clamped, `null` draws an empty track. */
  value: number | null;
  /** What the ratio is of — the meter's accessible name. */
  label: string;
  className?: string;
}

/** One ratio against its whole — the renewal rate (F-1001-c). The figure is written beside it, never colour alone. */
export function Meter({ value, label, className }: MeterProps) {
  const { main } = useChartTheme();
  const { percent } = useChartFormat();
  const ratio = value === null ? 0 : Math.min(1, Math.max(0, value));
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value === null ? undefined : Math.round(ratio * 100)}
        className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--chart-grid)]"
      >
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${ratio * 100}%`, background: main }} />
      </div>
      <span className="text-xs font-semibold tabular-nums text-text-primary">{value === null ? "—" : percent(ratio)}</span>
    </div>
  );
}
