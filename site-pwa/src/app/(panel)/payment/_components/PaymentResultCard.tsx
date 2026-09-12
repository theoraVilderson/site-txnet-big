"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export interface PaymentResultCardProps {
  icon: LucideIcon;
  /** `leaf` for a settled payment, `error` for one that is not. */
  tone: "leaf" | "error";
  /** Already translated. */
  title: string;
  message: string;
  children?: ReactNode;
  actions: ReactNode;
}

const TONE = {
  leaf: { ring: "bg-leaf-bg text-primary", heading: "text-text-primary", border: "border-card-border" },
  error: { ring: "bg-error-bg text-error", heading: "text-error", border: "border-error-border" },
} as const;

/**
 * The frame both result pages share (F-093-f).
 *
 * One component rather than two near-identical pages: legacy's success and
 * failure screens were 200-line copies of each other, which is how the failure
 * one ended up importing `PaymentSuccessPage` under the other's name and how
 * only one of them ever got the animation work.
 */
export function PaymentResultCard({
  icon: Icon,
  tone,
  title,
  message,
  children,
  actions,
}: PaymentResultCardProps) {
  const style = TONE[tone];
  return (
    <div className="mx-auto w-full max-w-lg p-4 md:p-8">
      <div className={`rounded-3xl border ${style.border} bg-card-bg p-8 text-center shadow-lg`}>
        <span
          className={`mx-auto flex size-14 items-center justify-center rounded-full ${style.ring}`}
        >
          <Icon size={28} aria-hidden />
        </span>
        {/* The outcome is announced, not just drawn: a payer who cannot see the
            icon still hears which of the two pages they landed on. */}
        <h1 role="status" className={`mt-4 text-xl font-bold ${style.heading}`}>
          {title}
        </h1>
        <p className="mt-2 text-sm text-text-secondary">{message}</p>
        {children}
        <div className="mt-6 flex flex-col gap-2">{actions}</div>
      </div>
    </div>
  );
}
