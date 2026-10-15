"use client";

import { localPoint } from "@visx/event";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { cn } from "../cn";

/**
 * Hover, touch and keys for a chart (rule 9): the pointer picks the nearest
 * point, a tap pins it (touch has no hover), and the arrow keys walk the
 * points with the tooltip following. `count` is the number of points;
 * `nearest` maps a pointer x/y in the plot to one.
 */
export function useChartPointer(count: number, nearest: (x: number, y: number) => number | null) {
  const [active, setActive] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);

  const at = (e: PointerEvent<Element>) => {
    const p = localPoint(e);
    return p ? nearest(p.x, p.y) : null;
  };
  const clamp = (i: number) => Math.min(count - 1, Math.max(0, i));

  return {
    active,
    onPointerMove: (e: PointerEvent<Element>) => {
      if (e.pointerType === "mouse" && !pinned) setActive(at(e));
    },
    onPointerLeave: (e: PointerEvent<Element>) => {
      if (e.pointerType === "mouse" && !pinned) setActive(null);
    },
    onPointerDown: (e: PointerEvent<Element>) => {
      if (e.pointerType === "mouse") return;
      const i = at(e);
      setPinned(i !== null && !(pinned && i === active));
      setActive(pinned && i === active ? null : i);
    },
    onKeyDown: (e: KeyboardEvent<Element>) => {
      // Time runs left to right in every language (rule 8), so the keys do too.
      const moves: Record<string, (i: number) => number> = { ArrowRight: (i) => i + 1, ArrowLeft: (i) => i - 1, Home: () => 0, End: () => count - 1 };
      if (e.key === "Escape") {
        setActive(null);
        setPinned(false);
        return;
      }
      const move = moves[e.key];
      if (!move || count === 0) return;
      e.preventDefault();
      setActive((i) => clamp(move(i ?? -1)));
    },
    onBlur: () => {
      if (!pinned) setActive(null);
    },
  };
}

/** One line of a tooltip: a swatch, what it is, and the full value. */
export interface TooltipRow {
  id: string;
  label: string;
  value: string;
  color?: string;
  dashed?: boolean;
}

/**
 * The tooltip box, placed at `x`/`y` in the plot and kept inside `width`. Its
 * text runs in the page's direction even though the plot is `ltr` (rule 8).
 */
export function ChartTooltip({ x, y, width, title, rows, extra }: { x: number; y: number; width: number; title: string; rows: readonly TooltipRow[]; extra?: ReactNode }) {
  const { isRtl } = useLocale();
  const flip = x > width / 2;
  return (
    <div
      role="status"
      dir={isRtl ? "rtl" : "ltr"}
      className={cn("pointer-events-none absolute z-10 min-w-36 rounded-xl border border-card-border bg-bg-inner px-3 py-2 text-xs shadow-[0_8px_24px_var(--card-shadow)]")}
      style={{ top: Math.max(0, y - 8), ...(flip ? { right: width - x + 12 } : { left: x + 12 }) }}
    >
      <p className="mb-1 font-semibold text-text-primary">{title}</p>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-3 text-text-secondary">
            <span className="flex items-center gap-1.5">
              {row.color && <span aria-hidden className="inline-block h-0 w-3 border-t-2" style={{ borderColor: row.color, borderTopStyle: row.dashed ? "dashed" : "solid" }} />}
              {row.label}
            </span>
            <span className="font-semibold tabular-nums text-text-primary">{row.value}</span>
          </li>
        ))}
      </ul>
      {extra && <div className="mt-1.5">{extra}</div>}
    </div>
  );
}
