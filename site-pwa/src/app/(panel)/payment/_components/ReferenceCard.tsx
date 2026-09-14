"use client";

import { useState } from "react";
import { Check, Copy, ReceiptText } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { copyText } from "../../_lib/clipboard";
import { PAYMENT_RESULT_KEYS as P } from "../_lib/payment-result";

/**
 * The bank's receipt number, copied rather than retyped (F-093-f).
 *
 * The tick follows what `copyText` actually answered, the same way
 * `financial/_components/DetailItem.tsx` does — legacy showed it
 * unconditionally, so a refused copy looked like a successful one.
 *
 * Drawn as a ticket (`pay-ticket`), in the panel's green — never gold.
 */
export function ReferenceCard({ reference }: { reference: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!(await copyText(reference))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="pay-ticket relative mt-7 overflow-hidden rounded-2xl border border-card-border bg-leaf-bg">
      <span aria-hidden className="pay-shine pointer-events-none absolute inset-0" />

      <div className="flex items-center justify-center gap-1.5 px-6 pt-4 text-xs font-medium text-text-label">
        <ReceiptText size={14} aria-hidden />
        {t("common", P.success.reference)}
      </div>
      <p dir="ltr" className="px-6 pt-1 pb-4 font-mono text-xl font-bold tracking-[0.12em] break-all text-text-primary">
        {reference}
      </p>

      <div aria-hidden className="mx-5 border-t-2 border-dashed border-card-border" />

      <button
        type="button"
        onClick={copy}
        className={`flex w-full items-center justify-center gap-2 px-6 py-3 text-sm font-semibold transition-colors ${
          copied ? "text-primary" : "text-text-secondary hover:text-text-primary"
        } active:scale-[0.98]`}
      >
        {copied ? (
          <Check key="done" size={16} strokeWidth={3} className="pay-pop-in" aria-hidden />
        ) : (
          <Copy key="copy" size={16} aria-hidden />
        )}
        <span aria-live="polite">{t("common", copied ? P.success.copied : P.success.copy)}</span>
      </button>
    </div>
  );
}
