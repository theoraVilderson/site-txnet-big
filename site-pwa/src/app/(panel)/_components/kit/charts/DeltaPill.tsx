"use client";

import { ArrowDownRight, ArrowUpRight, Minus, Sparkles } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { cn } from "../cn";
import { useChartFormat } from "./format";

const K = FrontendI18nKeys.common.kit.chart;

/** A change against the previous period: a ratio, `new` when it was zero, `null` with nothing compared. */
export type ChartDelta = number | "new" | null;

export interface DeltaPillProps {
  delta: ChartDelta;
  /** Whether a fall is the good news — refunds, failed payments. Rising is good otherwise. */
  downIsGood?: boolean;
  /** Leave off "vs previous" where the card already says it. */
  bare?: boolean;
  className?: string;
}

/**
 * ▲/▼ with the percent and "vs previous" (F-1001-c). A status colour says
 * good or bad, and never alone: the arrow and the word say it too (rule 4).
 */
export function DeltaPill({ delta, downIsGood = false, bare, className }: DeltaPillProps) {
  const { t } = useLocale();
  const { percent } = useChartFormat();
  if (delta === null) return null;

  const isNew = delta === "new";
  const isFlat = delta === 0;
  const up = isNew || (typeof delta === "number" && delta > 0);
  const good = isFlat ? null : up !== downIsGood;
  const Icon = isNew ? Sparkles : isFlat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const amount = typeof delta === "number" ? percent(Math.abs(delta)) : "";
  const text = isNew ? t("common", K.new) : isFlat ? t("common", K.flat) : t("common", up ? K.up : K.down, { value: amount });

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums",
        good === null ? "border-card-border text-text-secondary" : good ? "border-success-border bg-success-bg text-success" : "border-error-border bg-error-bg text-error",
        className,
      )}
    >
      <Icon size={13} aria-hidden />
      <span>{text}</span>
      {!bare && <span className="font-normal opacity-80">{t("common", K.vsPrevious)}</span>}
    </span>
  );
}
