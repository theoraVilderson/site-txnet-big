"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { formatMoney } from "../../_lib/money";
import { MAX_PRESETS, addPreset, type PresetError } from "../_lib/presets";
import { Button, Input } from "../../_components/kit";

const P = FrontendI18nKeys.common.gateways.presets;

interface PresetsEditorProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Shown when the list is empty — what the top-up page will offer instead. */
  emptyText: string;
  /** What the amounts are in: the gateway's own, or the tenant's for its default list (F-116-h3). */
  currency: string;
  id?: string;
}

/**
 * One quick-amount list (F-093-k): chips to remove, a box to add. Every add
 * goes through `addPreset`, so the list on screen is already the one billing
 * will store — sorted, two decimals, no repeats, at most {@link MAX_PRESETS}.
 */
export function PresetsEditor({ value, onChange, emptyText, currency, id }: PresetsEditorProps) {
  const { lang, t } = useLocale();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<PresetError | null>(null);

  const add = () => {
    if (!draft.trim()) return;
    const out = addPreset(value, draft);
    if ("error" in out) return setError(out.error);
    onChange(out.list);
    setDraft("");
    setError(null);
  };

  const full = value.length >= MAX_PRESETS;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-2xl border border-dashed border-card-border bg-[var(--bg-inner)] p-2">
        {value.length === 0 ? (
          <span className="px-1 text-2xs leading-5 text-text-secondary">{emptyText}</span>
        ) : (
          value.map((amount) => (
            <span
              key={amount}
              dir="ltr"
              className="inline-flex items-center gap-1 rounded-full border border-[var(--accent-primary)]/40 bg-card-bg py-1 pe-1 ps-3 text-xs font-bold text-text-primary shadow-sm"
            >
              {formatMoney(amount, currency, { lang, t })}
              <button
                type="button"
                onClick={() => onChange(value.filter((v) => v !== amount))}
                aria-label={t("common", P.remove, { amount })}
                className="grid size-5 place-items-center rounded-full text-text-secondary transition-colors hover:bg-[var(--error-bg)] hover:text-error"
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))
        )}
      </div>

      <div className="flex items-start gap-2">
        <div className="flex-1" dir="ltr">
          <Input
            id={id}
            inputMode="decimal"
            value={draft}
            disabled={full}
            placeholder={t("common", P.placeholder)}
            aria-invalid={Boolean(error)}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            end={<span className="pointer-events-none pe-1.5 text-xs font-bold text-text-secondary">{currency}</span>}
          />
        </div>
        <Button
          variant="primary"
          onClick={add}
          disabled={full || !draft.trim()}
          icon={<Plus size={14} aria-hidden />}
          className="shrink-0"
        >
          {t("common", P.add)}
        </Button>
      </div>

      <div className="flex items-center justify-between gap-2 text-2xs">
        {error ? (
          <span role="alert" className="font-bold text-error">
            {t("common", P.errors[error], { max: String(MAX_PRESETS) })}
          </span>
        ) : (
          <span />
        )}
        <span className="text-text-secondary" dir="ltr">
          {t("common", P.count, { count: String(value.length), max: String(MAX_PRESETS) })}
        </span>
      </div>
    </div>
  );
}
