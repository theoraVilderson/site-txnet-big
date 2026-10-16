import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

const PADDING = { none: "", sm: "p-3", md: "p-4 sm:p-5", lg: "p-5 sm:p-6" } as const;

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: keyof typeof PADDING;
  /** Lifts on hover — for a card that is itself a link or a choice. */
  interactive?: boolean;
}

/** The panel's surface (UX-1-c, `contract.ux.md` K6). */
export function Card({ padding = "md", interactive, className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-card-border bg-card-bg shadow-[0_1px_2px_var(--card-shadow)]",
        PADDING[padding],
        interactive && "transition-[transform,box-shadow,border-color] duration-200 hover:border-primary motion-safe:hover:-translate-y-0.5 hover:shadow-[0_8px_24px_var(--card-shadow)]",
        className,
      )}
      {...rest}
    />
  );
}

/** A card's heading row: title and a line under it, actions at the end. */
export function CardHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    // Wraps: actions that do not fit beside the title go under it, never past a phone's edge.
    <div className={cn("mb-4 flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="text-base font-bold text-text-primary">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-text-secondary">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
