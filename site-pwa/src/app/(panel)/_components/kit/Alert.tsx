import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { TONE_PILL } from "./StatusPill";

export type AlertTone = "info" | "success" | "warning" | "error";

const ICON: Record<AlertTone, LucideIcon> = { info: Info, success: CheckCircle2, warning: AlertTriangle, error: AlertCircle };

export interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  /** One action at the end — a `Button size="sm"`. */
  action?: ReactNode;
  className?: string;
}

/**
 * A message that stays on the page until its cause goes away (UX-1-c,
 * `contract.ux.md` K6) — unlike a toast (K10), which reports an action and
 * leaves. An error is announced at once (`role="alert"`), the rest politely.
 */
export function Alert({ tone = "info", title, children, action, className }: AlertProps) {
  const Icon = ICON[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-tone={tone}
      className={cn("flex flex-col gap-3 rounded-2xl border p-3.5 text-sm sm:flex-row sm:items-start", TONE_PILL[tone], className)}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <Icon size={18} aria-hidden className="mt-px shrink-0" />
        <div className="min-w-0">
          {title && <p className="font-bold">{title}</p>}
          {children && <div className={cn("text-text-primary", title && "mt-0.5")}>{children}</div>}
        </div>
      </div>
      {action && <div className="shrink-0 sm:ms-auto">{action}</div>}
    </div>
  );
}
