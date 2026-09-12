"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { copyText } from "../../_lib/clipboard";
import { PAYMENT_RESULT_KEYS as P } from "../_lib/payment-result";

/**
 * The bank's receipt number, copied rather than retyped (F-093-f).
 *
 * The tick follows what `copyText` actually answered, the same way
 * `financial/_components/DetailItem.tsx` does — legacy showed it
 * unconditionally, so a refused copy looked like a successful one.
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
    <div className="mt-6 rounded-2xl border border-card-border bg-gold-bg p-4">
      <span className="text-[10px] tracking-widest text-gold uppercase">
        {t("common", P.success.reference)}
      </span>
      <div className="mt-1 flex items-center justify-center gap-2">
        <span dir="ltr" className="font-mono text-lg font-bold break-all text-text-primary">
          {reference}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={t("common", copied ? P.success.copied : P.success.copy)}
          className="shrink-0 rounded-md p-1 text-gold transition-colors hover:bg-gold-bg"
        >
          {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
        </button>
      </div>
    </div>
  );
}
