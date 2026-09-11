"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Skeleton } from "./Skeleton";

const K = FrontendI18nKeys.common.kit;

export interface TableSkeletonProps {
  rows?: number;
  columns?: number;
  /** Draw the pagination bar's placeholder under the table. */
  withPagination?: boolean;
}

/**
 * The shape of a table while its page loads (F-093-b). Generic on purpose:
 * legacy's was the financial table's six columns hard-coded, and a page row
 * passes its own count instead. Below `md` a row collapses to an icon and one
 * line, the same way the tables it stands in for do.
 */
export function TableSkeleton({ rows = 5, columns = 5, withPagination = true }: TableSkeletonProps) {
  const { t } = useLocale();

  return (
    <div role="status" aria-busy="true" aria-label={t("common", K.loading)} className="w-full space-y-4">
      <div className="overflow-hidden rounded-3xl border border-card-border bg-card-bg">
        <div className="hidden gap-4 border-b border-card-border bg-leaf-bg px-6 py-4 md:flex">
          {Array.from({ length: columns }, (_, i) => (
            <Skeleton key={i} className="h-3 flex-1" />
          ))}
        </div>
        <div className="divide-y divide-card-border">
          {Array.from({ length: rows }, (_, row) => (
            <div key={row} className={`flex items-center gap-4 px-6 py-4 ${row % 2 ? "bg-bg-inner/30" : ""}`}>
              <Skeleton shape="circle" className="h-10 w-10 shrink-0" />
              <div className="flex flex-1 flex-col gap-2 md:hidden">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              {Array.from({ length: Math.max(columns - 1, 0) }, (_, col) => (
                <Skeleton key={col} className="hidden h-4 flex-1 md:block" />
              ))}
            </div>
          ))}
        </div>
      </div>
      {withPagination && (
        <div className="flex items-center justify-between pt-2">
          <Skeleton className="h-4 w-32" />
          <div className="flex gap-2">
            <Skeleton className="h-8 w-8" />
            <Skeleton className="h-8 w-8" />
          </div>
        </div>
      )}
    </div>
  );
}
