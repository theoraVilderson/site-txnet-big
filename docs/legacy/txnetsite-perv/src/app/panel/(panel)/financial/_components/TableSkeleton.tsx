// components/TableSkeleton.tsx
import React from "react";
import { cn } from "../_util/format";

// یک خط اسکلتون تکی
const SkeletonRow = ({ index }: { index: number }) => (
  <div
    className={cn(
      "grid grid-cols-1 md:grid-cols-12 gap-4 px-6 py-4 items-center border-b border-[var(--card-border)] animate-pulse",
      index % 2 === 0 ? "bg-[var(--card-bg)]" : "bg-[var(--bg-inner)]/30"
    )}
  >
    {/* Icon Circle */}
    <div className="md:col-span-1 flex justify-center">
      <div className="w-10 h-10 rounded-full bg-[var(--skeleton-bg)]"></div>
    </div>

    {/* Title & Date */}
    <div className="hidden md:block col-span-3 space-y-2">
      <div className="h-4 w-3/4 bg-[var(--skeleton-bg)] rounded"></div>
      <div className="h-3 w-1/2 bg-[var(--skeleton-bg)] rounded opacity-70"></div>
    </div>

    {/* Method/Status */}
    <div className="hidden md:flex col-span-2 flex-col items-center gap-2">
      <div className="h-4 w-20 bg-[var(--skeleton-bg)] rounded-full"></div>
      <div className="h-3 w-16 bg-[var(--skeleton-bg)] rounded opacity-60"></div>
    </div>

    {/* Date */}
    <div className="hidden md:block col-span-2 space-y-2 mx-auto">
      <div className="h-3 w-24 bg-[var(--skeleton-bg)] rounded mx-auto"></div>
      <div className="h-3 w-16 bg-[var(--skeleton-bg)] rounded mx-auto opacity-70"></div>
    </div>

    {/* Amount */}
    <div className="md:col-span-2 space-y-2 pl-4">
      <div className="h-5 w-24 bg-[var(--skeleton-bg)] rounded mr-auto"></div>
    </div>

    {/* Balance */}
    <div className="md:col-span-2 space-y-2 pl-4">
      <div className="h-4 w-20 bg-[var(--skeleton-bg)] rounded mr-auto opacity-70"></div>
    </div>
  </div>
);

export function TableSkeleton() {
  return (
    <div className="w-full space-y-4">
      {/* شبیه‌سازی هدر */}
      <div className="h-8 w-48 bg-[var(--skeleton-bg)] rounded-lg mb-6 animate-pulse"></div>

      <div className="glass-panel w-full rounded-3xl overflow-hidden border border-[var(--card-border)] shadow-sm">
        {/* شبیه‌سازی هدر جدول */}
        <div className="hidden md:grid grid-cols-12 gap-4 px-6 py-4 bg-[var(--leaf-bg)] border-b border-[var(--card-border)]">
          {[...Array(6)].map((_, i) => (
            <div
              key={i}
              className={`h-3 bg-[var(--text-secondary)]/20 rounded ${
                i === 0 ? "col-span-1" : "col-span-2"
              }`}
            ></div>
          ))}
        </div>

        {/* سطرها */}
        <div className="divide-y divide-[var(--card-border)]">
          {[...Array(5)].map((_, i) => (
            <SkeletonRow key={i} index={i} />
          ))}
        </div>
      </div>

      {/* شبیه‌سازی Pagination */}
      <div className="flex justify-between items-center pt-4">
        <div className="h-4 w-32 bg-[var(--skeleton-bg)] rounded animate-pulse"></div>
        <div className="flex gap-2">
          <div className="w-8 h-8 bg-[var(--skeleton-bg)] rounded animate-pulse"></div>
          <div className="w-8 h-8 bg-[var(--skeleton-bg)] rounded animate-pulse"></div>
        </div>
      </div>
    </div>
  );
}
