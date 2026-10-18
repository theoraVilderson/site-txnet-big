"use client";

import { useLocale } from "@/context/LocaleContext";
import { K } from "./ai-ui";
import { Field, Input } from "../../_components/kit";

interface Props {
  threshold: string;
  holdoutPercent: string;
  onThreshold: (value: string) => void;
  onHoldout: (value: string) => void;
}

/**
 * The exact numbers behind the levels, folded away (F-038-j4): the threshold
 * as ai stores it, and the holdout share said as "N in every 100 customers".
 */
export function AiAdvancedSettings({ threshold, holdoutPercent, onThreshold, onHoldout }: Props) {
  const { t } = useLocale();
  return (
    <details className="group rounded-2xl border border-card-border bg-bg-inner p-3">
      <summary className="cursor-pointer text-sm font-bold text-text-primary">{t("common", K.settings.advanced)}</summary>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field id="ai-threshold" label={t("common", K.settings.threshold)} hint={t("common", K.settings.thresholdHint)}>
          <Input id="ai-threshold" inputMode="decimal" dir="ltr" value={threshold} onChange={(e) => onThreshold(e.target.value.trim())} />
        </Field>
        <Field id="ai-holdout" label={t("common", K.settings.holdout)} hint={t("common", K.settings.holdoutHint)}>
          <Input id="ai-holdout" inputMode="numeric" dir="ltr" value={holdoutPercent} onChange={(e) => onHoldout(e.target.value.trim())} />
        </Field>
      </div>
      <p className="mt-2 text-xs text-text-secondary">{t("common", K.settings.holdoutExample, { n: holdoutPercent })}</p>
    </details>
  );
}
