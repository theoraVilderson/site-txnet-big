import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: ReactNode;
  /** One sentence: why it is empty, or what fills it. */
  body?: ReactNode;
  /** At most one — a `Button`. */
  action?: ReactNode;
  className?: string;
}

/** A list or a page with nothing in it yet (UX-1-c, `contract.ux.md` K6). */
export function EmptyState({ icon: Icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center gap-3 px-4 py-10 text-center", className)}>
      <span className="grid size-14 place-items-center rounded-2xl bg-leaf-bg text-primary">
        <Icon size={26} aria-hidden />
      </span>
      <div className="max-w-sm">
        <p className="text-base font-bold text-text-primary">{title}</p>
        {body && <p className="mt-1 text-sm text-text-secondary">{body}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
