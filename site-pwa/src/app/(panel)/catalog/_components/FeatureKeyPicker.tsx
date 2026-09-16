"use client";

import { useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { CATALOG_KEYS as K, isFeatureKey } from "../_lib/catalog-form";
import { input } from "./catalog-ui";

/**
 * Capabilities as chips: every key the caller's products already use is one
 * click, and a new one is typed once and checked for billing's shape before it
 * is added. Nothing to remember (`featureKeysIn`).
 */
export function FeatureKeyPicker({
  value,
  onChange,
  known,
  error,
}: {
  value: string[];
  onChange: (keys: string[]) => void;
  known: readonly string[];
  error?: string;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const typed = query.trim().toLowerCase();
  const options = [...new Set([...known, ...value])].sort();
  const shown = typed ? options.filter((k) => k.includes(typed)) : options;
  const canAdd = typed !== "" && !options.includes(typed) && isFeatureKey(typed);
  const toggle = (k: string) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  const add = () => {
    if (!canAdd) return;
    onChange([...value, typed]);
    setQuery("");
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-bold text-text-secondary">{t("common", K.capabilities.label)}</p>
      <p className="text-[11px] text-text-secondary">{t("common", K.capabilities.hint)}</p>
      <input
        className={input}
        dir="ltr"
        value={query}
        placeholder={t("common", K.capabilities.search)}
        aria-label={t("common", K.capabilities.search)}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (canAdd) add();
            else if (shown.length === 1) toggle(shown[0]);
          }
        }}
      />
      {options.length === 0 && !typed && <p className="text-[11px] text-text-secondary">{t("common", K.capabilities.empty)}</p>}
      <div className="flex flex-wrap gap-1.5">
        {shown.map((k) => {
          const on = value.includes(k);
          return (
            <button
              key={k}
              type="button"
              dir="ltr"
              aria-pressed={on}
              onClick={() => toggle(k)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[11px] font-bold ${
                on ? "border-primary bg-primary text-white" : "border-card-border bg-bg-inner text-text-primary hover:border-primary"
              }`}
            >
              {on ? <Check size={12} aria-hidden /> : null}
              {k}
              {on ? <X size={12} aria-label={t("common", K.capabilities.remove, { key: k })} /> : null}
            </button>
          );
        })}
        {canAdd && (
          <button
            type="button"
            onClick={add}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-primary px-2.5 py-1 text-[11px] font-bold text-primary"
          >
            <Plus size={12} aria-hidden />
            {t("common", K.capabilities.add, { key: typed })}
          </button>
        )}
      </div>
      {typed !== "" && !canAdd && !options.includes(typed) && shown.length === 0 && (
        <p className="text-[11px] text-error">{t("common", K.errors.featureKey)}</p>
      )}
      {error && <p className="text-[11px] text-error">{t("common", error)}</p>}
    </div>
  );
}
