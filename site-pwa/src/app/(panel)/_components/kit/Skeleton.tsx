import type { HTMLAttributes } from "react";

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** `circle` for an avatar or an icon; size it with `className`. */
  shape?: "rounded" | "circle";
}

/**
 * A placeholder block (F-093-b). Decorative: the region that is loading says
 * so once, with `aria-busy` — see `TableSkeleton` — not every block in it.
 * Plain Tailwind on the theme's `--skeleton-bg`, where legacy wrapped MUI's.
 */
export function Skeleton({ shape = "rounded", className = "", ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={`animate-pulse bg-[var(--skeleton-bg)] ${
        shape === "circle" ? "rounded-full" : "rounded-xl"
      } ${className}`}
      {...props}
    />
  );
}
