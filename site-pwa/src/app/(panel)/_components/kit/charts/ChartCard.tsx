"use client";

import { AlertTriangle, ChartLine, Inbox, Table2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Button, IconButton } from "../Button";
import { Card, CardHeader } from "../Card";
import { cn } from "../cn";
import { DataTable, type DataColumn } from "../DataTable";
import { EmptyState } from "../EmptyState";
import { Skeleton } from "../Skeleton";

const K = FrontendI18nKeys.common.kit.chart;

/** One legend entry: what a colour is. A dashed swatch is the previous period. */
export interface LegendItem {
  id: string;
  label: string;
  color: string;
  dashed?: boolean;
}

/** The chart's exact numbers as a table (rule 6) — the accessible reading, and the relief for light slots under 3:1. */
export interface ChartTable<T> {
  columns: readonly DataColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
}

export interface ChartCardProps<T> {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Shown when there are two or more (rule 5); a single series is named by the title. */
  legend?: readonly LegendItem[];
  table: ChartTable<T>;
  /** `loading`: first load, a skeleton shaped like the chart; `error`: this card alone, with its own retry (rule 11). */
  state?: "ready" | "loading" | "empty" | "error";
  /** A filter changed and the new figures are on their way: the old chart stays, at half strength. */
  stale?: boolean;
  onRetry?: () => void;
  /** The plot's height, which the skeleton keeps. */
  height?: number;
  /** Beside the table toggle — a `SegmentedControl` switching the metric. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

function Legend({ items }: { items: readonly LegendItem[] }) {
  if (items.length < 2) return null;
  return (
    <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0 w-4 border-t-2" style={{ borderColor: item.color, borderTopStyle: item.dashed ? "dashed" : "solid" }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * The frame every chart sits in (F-1001-c): title, subtitle, legend, the
 * table-view toggle, and its own skeleton, empty and error states — so one
 * card fails alone and a filter change never flashes a skeleton.
 */
export function ChartCard<T>({ title, subtitle, legend = [], table, state = "ready", stale, onRetry, height = 220, actions, className, children }: ChartCardProps<T>) {
  const { t } = useLocale();
  const [asTable, setAsTable] = useState(false);
  const label = typeof title === "string" ? title : t("common", K.value);

  const toggle = (
    <IconButton
      variant="quiet"
      size="sm"
      aria-pressed={asTable}
      aria-label={t("common", asTable ? K.showChart : K.showTable)}
      icon={asTable ? <ChartLine size={16} aria-hidden /> : <Table2 size={16} aria-hidden />}
      onClick={() => setAsTable((v) => !v)}
      disabled={state !== "ready"}
    />
  );

  return (
    <Card className={className} aria-busy={state === "loading" || stale || undefined}>
      <CardHeader title={title} subtitle={subtitle} actions={<>{actions}{toggle}</>} />
      {state === "loading" && <Skeleton style={{ height }} className="w-full" />}
      {state === "empty" && <EmptyState icon={Inbox} title={t("common", K.empty)} />}
      {state === "error" && (
        <EmptyState
          icon={AlertTriangle}
          title={t("common", K.failed)}
          action={onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>{t("common", K.retry)}</Button>}
        />
      )}
      {state === "ready" && (
        <div className={cn("transition-opacity duration-200", stale && "opacity-50")}>
          {asTable ? (
            <DataTable label={label} rows={table.rows} columns={table.columns} rowKey={table.rowKey} compact bare />
          ) : (
            <>
              <Legend items={legend} />
              {children}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
