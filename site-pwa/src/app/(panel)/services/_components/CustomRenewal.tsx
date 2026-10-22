"use client";

import { Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import type { RenewalCustom } from "@/lib/billing-api";
import { Field, Input } from "../../_components/kit";
import type { useRenewalQuote } from "../_hooks/useRenewalQuote";
import type { TypedRenewal } from "../_lib/renewal";
import { RefusalNote } from "./RefusalNote";

const C = FrontendI18nKeys.common.myServices.renew.custom;

/**
 * GiB and days typed on the renewal sheet (F-305-g, `contract.renewal.md` rule
 * 4): a field per part this Grant can take — billing's bounds for it say a
 * most of 0 for the other — each with its bounds beside it. What it costs is
 * billing's quote, shown by the checkout under it; a refusal is billing's
 * sentence, here.
 */
export function CustomRenewal({
  custom,
  typed,
  onTyped,
  quote,
}: {
  custom: RenewalCustom;
  typed: TypedRenewal;
  onTyped: (next: TypedRenewal) => void;
  quote: ReturnType<typeof useRenewalQuote>;
}) {
  const { t } = useLocale();
  const toMessage = useApiErrorMessage();
  const parts = [
    { part: "gib", label: C.gib, min: custom.minGib, max: custom.maxGib },
    { part: "days", label: C.days, min: custom.minDays, max: custom.maxDays },
  ] as const;

  return (
    <div className="space-y-3 rounded-2xl border border-card-border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {parts
          .filter((p) => p.max > 0)
          .map((p) => (
            <Field key={p.part} label={t("common", p.label)} hint={t("common", C.bounds, { min: p.min, max: p.max })}>
              <Input dir="ltr" inputMode="numeric" value={typed[p.part]} onChange={(e) => onTyped({ ...typed, [p.part]: e.target.value })} />
            </Field>
          ))}
      </div>
      {quote.pending && (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t("common", C.pricing)}
        </p>
      )}
      {quote.error != null && <RefusalNote error={{ message: toMessage(quote.error), ref: quote.error instanceof ApiError ? quote.error.ref : undefined }} />}
    </div>
  );
}
