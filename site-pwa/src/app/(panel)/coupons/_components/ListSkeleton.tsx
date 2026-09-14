"use client";

import { Skeleton } from "../../_components/kit/Skeleton";

/** The list's final shape while it loads, so nothing moves when the data arrives. */
export function ListSkeleton({ label }: { label: string }) {
  return (
    <div className="divide-y divide-card-border rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6" aria-busy="true" aria-label={label}>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center justify-between gap-3 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40 max-w-full" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-7 w-14" />
          </div>
        </div>
      ))}
    </div>
  );
}
