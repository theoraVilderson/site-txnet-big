"use client";

import type { ReactNode } from "react";
import { Inbox, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";

const F = FrontendI18nKeys.common.financial;

export interface FinancialTableProps {
  /** Column headings, already translated. Shown from `md` up. */
  columns: string[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  /** Shown when the list came back empty — a filter matching nothing is not a failure. */
  emptyLabel: string;
  children: ReactNode;
  /** Whether `children` is empty, decided by the caller that has the rows. */
  isEmpty: boolean;
}

/**
 * The frame both lists render in (F-093-d): the heading row, and the three
 * states a table can be in.
 *
 * **The skeleton is the loading state, not a route transition.** Legacy put a
 * `Suspense key` on the serialised search params and a `LoadingContext` that
 * the filter panel poked so the skeleton appeared before the server action
 * answered. Here the read is a client fetch keyed to the filters
 * (`useFinancialPage`), so "a read is in flight" is a value this component is
 * handed, and the two mechanisms that guessed at it are gone.
 *
 * **An empty page and a failed read look different.** They were one state in
 * legacy — a failure rendered the empty table — so a user whose request was
 * rate-limited was told they had no transactions.
 */
export function FinancialTable({
  columns,
  isLoading,
  error,
  onRetry,
  emptyLabel,
  children,
  isEmpty,
}: FinancialTableProps) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();

  if (isLoading) return <TableSkeleton rows={5} columns={columns.length} withPagination />;

  return (
    <div className="w-full overflow-hidden rounded-3xl border border-card-border bg-card-bg">
      <div className="hidden grid-cols-12 gap-3 border-b border-card-border bg-leaf-bg px-6 py-3 text-[11px] font-bold text-text-secondary md:grid">
        <div className="col-span-1 text-center">{columns[0]}</div>
        <div className="col-span-4">{columns[1]}</div>
        <div className="col-span-2">{columns[2]}</div>
        <div className="col-span-2 text-center">{columns[3]}</div>
        <div className="col-span-3 text-end">{columns[4]}</div>
      </div>

      <div className="min-h-[280px]">
        {error ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <p className="max-w-md px-6 text-sm text-error">{errorMessage(error)}</p>
            <button
              type="button"
              onClick={onRetry}
              className="flex items-center gap-2 rounded-lg border border-card-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-leaf-bg"
            >
              <RotateCw size={14} aria-hidden />
              {t("common", F.retry)}
            </button>
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-text-secondary">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-leaf-bg text-primary">
              <Inbox size={26} aria-hidden />
            </span>
            <p className="text-sm">{emptyLabel}</p>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
