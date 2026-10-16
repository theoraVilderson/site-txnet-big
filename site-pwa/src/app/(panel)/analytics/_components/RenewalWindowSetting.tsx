"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { RENEWAL_WINDOW_DAYS, setAnalyticsSettings } from "@/lib/billing/analytics";
import { Button, Card, Field, Input, notify } from "../../_components/kit";

const K = FrontendI18nKeys.common.analytics.customers.window;

/** A whole number of days inside billing's bounds, or nothing to send. */
function daysOf(text: string): number | null {
  const n = Number(text);
  return Number.isInteger(n) && n >= RENEWAL_WINDOW_DAYS.min && n <= RENEWAL_WINDOW_DAYS.max ? n : null;
}

/**
 * The tenant's renewal window (F-1001-g; billing `contract.analytics-tabs.md`
 * Customers rule 3): days before or after a term's end a renewal counts in.
 * Saved, billing re-states every term and the page re-reads on its event;
 * `onSaved` re-reads at once for the one who saved.
 */
export function RenewalWindowSetting({ tenantId, current, onSaved }: { tenantId: string; current: number; onSaved: () => void }) {
  const { t } = useLocale();
  const errorText = useApiErrorMessage();
  const [text, setText] = useState(String(current));
  const [saving, setSaving] = useState(false);
  const days = daysOf(text);

  const save = async () => {
    if (days === null) return;
    setSaving(true);
    try {
      await setAnalyticsSettings(tenantId, { renewalWindowDays: days });
      notify.success(t("common", K.saved, { days }));
      onSaved();
    } catch (e) {
      notify.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding="sm" className="flex flex-wrap items-end gap-3">
      <Field label={t("common", K.label)} hint={t("common", K.hint, { min: RENEWAL_WINDOW_DAYS.min, max: RENEWAL_WINDOW_DAYS.max })}>
        <Input dir="ltr" type="number" inputMode="numeric" min={RENEWAL_WINDOW_DAYS.min} max={RENEWAL_WINDOW_DAYS.max} className="w-24" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Button size="sm" onClick={save} disabled={days === null || days === current || saving}>
        {t("common", K.save)}
      </Button>
    </Card>
  );
}
