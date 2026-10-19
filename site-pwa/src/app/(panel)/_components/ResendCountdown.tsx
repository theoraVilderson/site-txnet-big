"use client";

import { Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

const C = FrontendI18nKeys.common.accounts;

/** "Send again in 0:42 seconds" — the server's wait (`resendIn` / `retryAfter`), as `useOtpTimer` formats it. */
export function ResendCountdown({ formatted }: { formatted: string }) {
  const { t } = useLocale();
  return (
    <div className="flex items-center justify-center gap-2 text-sm text-text-secondary">
      <Loader2 size={16} className="animate-spin text-primary" aria-hidden />
      {t("common", C.resendCodeIn)}{" "}
      <span className="inline-block min-w-[40px] text-center font-mono font-bold text-text-primary" dir="ltr">
        {formatted}
      </span>{" "}
      {t("common", C.seconds)}
    </div>
  );
}
