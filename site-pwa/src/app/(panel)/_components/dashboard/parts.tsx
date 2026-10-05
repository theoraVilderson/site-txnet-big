"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";

/** A widget's way to its page, at the card's foot (D1). */
export function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  const { isRtl } = useLocale();
  const Arrow = isRtl ? ArrowLeft : ArrowRight;
  return (
    <Link href={href} className="mt-auto inline-flex items-center gap-1.5 pt-4 text-sm font-bold text-primary hover:underline">
      {children}
      <Arrow size={14} aria-hidden />
    </Link>
  );
}

/** A widget's list: rows divided by a hairline. */
export function WidgetList({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-card-border">
      {children}
    </ul>
  );
}
