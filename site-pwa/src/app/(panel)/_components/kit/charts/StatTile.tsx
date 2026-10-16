"use client";

import { scaleLinear } from "@visx/scale";
import { LinePath } from "@visx/shape";
import type { ReactNode } from "react";
import { AnimatedNumber } from "../AnimatedNumber";
import { Card } from "../Card";
import { cn } from "../cn";
import { DeltaPill, type ChartDelta } from "./DeltaPill";
import { finite } from "./plot";
import { useChartTheme } from "./useChartTheme";

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 28;

export interface StatTileProps {
  label: ReactNode;
  value: number;
  /** How the value is written — money in its currency, a count, bytes. */
  format: (n: number) => string;
  delta?: ChartDelta;
  downIsGood?: boolean;
  /** The figure's recent shape; drawn only with two or more points. */
  spark?: readonly (number | null)[];
  /** 2 is the hero: twice the width and the type. */
  size?: 1 | 2;
  /** Under the figure — new / returning under buyers. */
  footer?: ReactNode;
  /** A tile that moves the hero to its metric is a button (Overview rule 2). */
  onSelect?: () => void;
  selected?: boolean;
  className?: string;
}

/** A sparkline: the series' shape, no axis, in the main colour. Decorative — the figure beside it is the reading. */
export function Sparkline({ values }: { values: readonly (number | null)[] }) {
  const { main } = useChartTheme();
  const points = values.flatMap((v, i) => (v === null ? [] : [{ i, v }]));
  if (points.length < 2) return null;
  const nums = finite(values);
  const x = scaleLinear<number>({ domain: [0, values.length - 1], range: [1, SPARK_WIDTH - 1] });
  const y = scaleLinear<number>({ domain: [Math.min(...nums), Math.max(...nums) || 1], range: [SPARK_HEIGHT - 2, 2] });
  return (
    // Not on a phone: two tiles a row leave no room for 96px beside the figure, and the row would push the grid past the edge.
    <svg width={SPARK_WIDTH} height={SPARK_HEIGHT} aria-hidden className="hidden shrink-0 sm:block">
      <LinePath data={points} x={(p) => x(p.i)} y={(p) => y(p.v)} stroke={main} strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

/** A value, its change and its shape (F-1001-c): `size` 1, or 2 for the hero. */
export function StatTile({ label, value, format, delta = null, downIsGood, spark, size = 1, footer, onSelect, selected, className }: StatTileProps) {
  const body = (
    <>
      <p className="text-xs font-semibold text-text-label">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-2">
        <AnimatedNumber value={value} format={format} className={cn("font-black text-text-primary", size === 2 ? "text-3xl" : "text-xl")} />
        {spark && <Sparkline values={spark} />}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <DeltaPill delta={delta} downIsGood={downIsGood} bare={size === 1} />
        {footer && <span className="text-xs text-text-secondary">{footer}</span>}
      </div>
    </>
  );
  return (
    <Card padding="sm" interactive={Boolean(onSelect)} className={cn(size === 2 && "sm:col-span-2", selected && "border-primary", className)}>
      {onSelect ? (
        <button type="button" aria-pressed={selected} onClick={onSelect} className="block w-full text-start outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg">
          {body}
        </button>
      ) : (
        body
      )}
    </Card>
  );
}
