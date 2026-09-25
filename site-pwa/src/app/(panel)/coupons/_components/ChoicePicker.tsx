"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { Select } from "../../_components/kit/Select";
import { RULE_KEYS } from "../_lib/discount-rules";

const F = RULE_KEYS.form;

const input =
  "w-full rounded-xl border border-card-border bg-[var(--bg-inner)] px-3 py-2.5 text-sm text-[var(--text-input)] placeholder:text-[var(--text-label)] transition-colors hover:border-[var(--accent-primary)] focus:border-[var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)] disabled:opacity-60";

export interface Choice {
  value: string;
  label: string;
}

/** A list read for a picker: `null` while it loads, `"failed"` when the caller may not read it. */
export type Choices = Choice[] | null | "failed";

/**
 * One product, category or group for a discount rule (F-114-k). The lists
 * come from routes with their own permissions (`catalog.manage`,
 * `user_group.manage`) that a coupon manager may not hold, so a failed read
 * falls back to typing the id, as the free-service variant picker does. A
 * saved id the list does not hold opens as typed, so an edit never blanks it.
 */
export function ChoicePicker({ id, value, onChange, choices, invalid = false }: { id: string; value: string; onChange: (v: string) => void; choices: Choices; invalid?: boolean }) {
  const { t } = useLocale();
  const [manual, setManual] = useState(false);

  if (choices === null) return <p className="py-2.5 text-xs text-text-secondary">{t("common", F.loading)}</p>;

  const listed = Array.isArray(choices) ? choices : [];
  const unknownValue = Array.isArray(choices) && value.trim() !== "" && !listed.some((c) => c.value === value.trim());
  const byHand = choices === "failed" || manual || unknownValue;

  const toggle = (label: string, next: boolean) =>
    choices !== "failed" && (
      <button
        type="button"
        onClick={() => {
          setManual(next);
          if (!next && unknownValue) onChange("");
        }}
        className="self-start text-[11px] font-bold text-primary hover:underline"
      >
        {label}
      </button>
    );

  if (byHand)
    return (
      <div className="flex flex-col gap-1">
        <input id={id} dir="ltr" aria-invalid={invalid} className={`${input} ${invalid ? "border-error focus:border-error" : ""}`} value={value} onChange={(e) => onChange(e.target.value)} />
        {toggle(t("common", F.fromList), false)}
      </div>
    );

  return (
    <div className="flex flex-col gap-1">
      {listed.length === 0 ? (
        <p className="py-2.5 text-xs text-text-secondary">{t("common", F.listEmpty)}</p>
      ) : (
        <Select id={id} value={value} onChange={onChange} invalid={invalid} placeholder={t("common", F.placeholder)} options={listed} />
      )}
      {toggle(t("common", F.byId), true)}
    </div>
  );
}
