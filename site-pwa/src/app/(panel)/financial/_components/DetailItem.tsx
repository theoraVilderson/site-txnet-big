"use client";

import { useState } from "react";
import { Check, Copy, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { COPY_FEEDBACK_MS, copyText } from "../../_lib/clipboard";
import { IconButton } from "../../_components/kit";

const F = FrontendI18nKeys.common.financial;

export interface DetailItemProps {
  icon: LucideIcon;
  /** Already translated. */
  label: string;
  value: string;
  /** A reference number is quoted to support, so it is copied rather than retyped. */
  copyable?: boolean;
  /** Show the value as it is written, left to right — an id, a card number, a rate. */
  ltr?: boolean;
  className?: string;
  valueClassName?: string;
}

/**
 * One labelled fact inside an expanded row (F-093-d).
 *
 * The copy button reports what actually happened: `copyText` resolves `false`
 * when the browser refuses (`contract.kit.md`), and this shows the tick only
 * then. Legacy showed it unconditionally, so a refused copy looked like a
 * successful one and the user pasted whatever was in the clipboard before.
 */
export function DetailItem({
  icon: Icon,
  label,
  value,
  copyable = false,
  ltr = false,
  className = "",
  valueClassName = "",
}: DetailItemProps) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!(await copyText(value))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };

  return (
    <div className={`rounded-xl border border-card-border bg-card-bg p-3 ${className}`}>
      <div className="mb-1 flex items-center gap-1.5 text-text-secondary">
        <Icon size={12} aria-hidden />
        <span className="text-3xs">{label}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span
          dir={ltr ? "ltr" : undefined}
          title={value}
          className={`truncate text-xs font-medium text-text-primary ${ltr ? "font-mono" : ""} ${valueClassName}`}
        >
          {value}
        </span>
        {copyable && (
          <IconButton
            size="sm"
            onClick={copy}
            aria-label={t("common", copied ? F.copied : F.copy)}
            icon={copied ? <Check size={12} className="text-primary" aria-hidden /> : <Copy size={12} aria-hidden />}
            className="size-6 rounded-md hover:text-primary"
          />
        )}
      </div>
    </div>
  );
}
