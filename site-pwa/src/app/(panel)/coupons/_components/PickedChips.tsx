"use client";

import { X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { COUPON_KEYS } from "../_lib/coupon-form";
import type { Choice } from "./ChoicePicker";

const P = COUPON_KEYS.form.picker;

/** How many characters of an id stand in for a name the page does not know. */
export const SHORT_ID = 8;

/**
 * What a multi-picker holds, one chip each with a remove button (UX-3-a). An
 * id with no known name — saved before, or typed — shows its first
 * {@link SHORT_ID} characters, so nothing picked is ever hidden.
 */
export function PickedChips({ items, onRemove, disabled = false }: { items: readonly Choice[]; onRemove: (value: string) => void; disabled?: boolean }) {
  const { t } = useLocale();
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li key={item.value} className="flex items-center gap-1 rounded-xl border border-card-border bg-[var(--bg-inner)] py-1 ps-2.5 pe-1 text-xs font-bold text-text-primary">
          <span className="max-w-56 truncate" dir="auto" title={item.value}>
            {item.label}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRemove(item.value)}
            aria-label={t("common", P.remove, { label: item.label })}
            className="rounded-lg p-0.5 text-text-secondary hover:text-error disabled:opacity-50"
          >
            <X size={12} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The chips for `ids`: each id's label from `known`, else its short form. */
export function chipsOf(ids: readonly string[], known: (id: string) => string | undefined): Choice[] {
  return ids.map((id) => ({ value: id, label: known(id) ?? id.slice(0, SHORT_ID) }));
}
