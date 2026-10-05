import type { ReactNode } from "react";
import { cn } from "./cn";

export type Tone = "neutral" | "success" | "warning" | "error" | "info" | "gold";

/** The tinted pill per tone. Gold is a status colour here, never a control's (K6, U3). */
export const TONE_PILL: Record<Tone, string> = {
  neutral: "border-card-border bg-leaf-bg text-text-secondary",
  success: "border-success-border bg-success-bg text-success",
  warning: "border-warning-border bg-warning-bg text-warning",
  error: "border-error-border bg-error-bg text-error",
  info: "border-info-border bg-info-bg text-info",
  gold: "border-gold/30 bg-gold-bg text-gold",
};

const DOT: Record<Tone, string> = {
  neutral: "bg-text-secondary",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  info: "bg-info",
  gold: "bg-gold",
};

export interface StatusPillProps {
  tone?: Tone;
  /** A leading dot — a state rather than a label. */
  dot?: boolean;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** A status in a pill (UX-1-c, `contract.ux.md` K6). */
export function StatusPill({ tone = "neutral", dot = true, icon, className, children }: StatusPillProps) {
  return (
    <span
      data-tone={tone}
      className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-bold", TONE_PILL[tone], className)}
    >
      {icon ?? (dot && <span aria-hidden className={cn("size-1.5 rounded-full", DOT[tone])} />)}
      {children}
    </span>
  );
}

/** A label or a count in a pill, without the dot. */
export function Badge(props: Omit<StatusPillProps, "dot">) {
  return <StatusPill {...props} dot={false} />;
}
