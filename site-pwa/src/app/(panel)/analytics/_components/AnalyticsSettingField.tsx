"use client";

import { useState } from "react";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { type AnalyticsSettingKey, setAnalyticsSettings } from "@/lib/billing/analytics";
import { Button, Card, Field, Input, notify } from "../../_components/kit";

/** What the field says, in the reader's language — each tab's own words. */
export interface SettingWords {
  label: string;
  hint: string;
  save: string;
  saved: (value: number) => string;
}

/** A whole number inside billing's bounds, or nothing to send. */
function wholeIn(text: string, bounds: { min: number; max: number }): number | null {
  const n = Number(text);
  return text.trim() !== "" && Number.isInteger(n) && n >= bounds.min && n <= bounds.max ? n : null;
}

/**
 * One of the tenant's analytics settings (billing `PUT …/analytics/settings`):
 * the renewal window on Customers (F-1001-g), the loss alert's percent on
 * Profit (F-1003). A whole number inside billing's bounds; saved, `onSaved`
 * re-reads at once for the one who saved, and every open page re-reads on
 * billing's event where the figures moved.
 */
export function AnalyticsSettingField({ tenantId, field, current, bounds, words, onSaved }: {
  tenantId: string;
  field: AnalyticsSettingKey;
  current: number;
  bounds: { min: number; max: number };
  words: SettingWords;
  onSaved: () => void;
}) {
  const errorText = useApiErrorMessage();
  const [text, setText] = useState(String(current));
  const [saving, setSaving] = useState(false);
  const value = wholeIn(text, bounds);

  const save = async () => {
    if (value === null) return;
    setSaving(true);
    try {
      await setAnalyticsSettings(tenantId, { [field]: value });
      notify.success(words.saved(value));
      onSaved();
    } catch (e) {
      notify.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding="sm" className="flex flex-wrap items-end gap-3">
      <Field label={words.label} hint={words.hint}>
        <Input dir="ltr" type="number" inputMode="numeric" min={bounds.min} max={bounds.max} className="w-24" value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Button size="sm" onClick={save} disabled={value === null || value === current || saving}>
        {words.save}
      </Button>
    </Card>
  );
}
