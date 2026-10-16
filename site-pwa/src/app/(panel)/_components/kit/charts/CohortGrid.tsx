"use client";

import { cn } from "../cn";
import { heatStep } from "./CalendarHeatmap";
import { useChartTheme } from "./useChartTheme";

/** A cohort's row: its label and size and one value per column, or one hidden from the reader. */
export type CohortGridRow =
  | { id: string; label: string; size: string; values: readonly (number | null)[]; display: readonly string[] }
  | { id: string; label: string; hidden: string };

export interface CohortGridProps {
  /** The table's accessible name. */
  label: string;
  rowHeader: string;
  sizeHeader: string;
  /** One header per column — month 0, 1, 2… */
  columns: readonly string[];
  rows: readonly CohortGridRow[];
  /** The value the darkest step stands for; the largest value when not given. */
  max?: number;
}

/** From this step on (of five) a cell is dark enough in the light theme that its words are drawn light. */
const LIGHT_TEXT_FROM = 3;

/**
 * The cohort grid (F-1004-b, panel-web `contract.analytics.md` "Chart kit"):
 * a heatmap table — one row per cohort, one column per month since, each
 * cell in the main series' sequential hue by its share of `max`. It is a real
 * `<table>`: every cell says its value in words, so the colour only helps
 * the eye (rules 4 and 6). A null value is a month not lived, an empty cell —
 * never a zero. Wider than a phone, it scrolls inside its card (rule 12).
 */
export function CohortGrid({ label, rowHeader, sizeHeader, columns, rows, max }: CohortGridProps) {
  const theme = useChartTheme();
  const top = max ?? Math.max(0, ...rows.flatMap((r) => ("values" in r ? r.values.filter((v): v is number => v !== null) : [])));
  return (
    <div className="w-full overflow-x-auto">
      <table aria-label={label} className="w-full border-separate border-spacing-0.5 text-xs">
        <thead>
          <tr>
            <th scope="col" className="px-2 py-1 text-start font-semibold text-text-secondary">{rowHeader}</th>
            <th scope="col" className="px-2 py-1 text-end font-semibold text-text-secondary">{sizeHeader}</th>
            {columns.map((c) => (
              <th key={c} scope="col" className="px-2 py-1 text-center font-semibold text-text-secondary" dir="ltr">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row" className="whitespace-nowrap px-2 py-1 text-start font-semibold">{row.label}</th>
              {"hidden" in row ? (
                <td colSpan={columns.length + 1} className="px-2 py-1 text-text-secondary">{row.hidden}</td>
              ) : (
                <>
                  <td className="px-2 py-1 text-end" dir="ltr">{row.size}</td>
                  {columns.map((c, i) => {
                    const step = heatStep(row.values[i] ?? null, top);
                    const light = step !== null && (theme.mode === "dark" || step >= LIGHT_TEXT_FROM);
                    return (
                      <td
                        key={c}
                        dir="ltr"
                        className={cn("min-w-14 rounded px-2 py-1 text-center tabular-nums", light ? "text-white" : "text-text-primary")}
                        style={step === null ? undefined : { background: theme.sequential[step] }}
                      >
                        {row.display[i] ?? ""}
                      </td>
                    );
                  })}
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
