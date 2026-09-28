"use client";

import { useState, type FormEvent } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi } from "@/lib/billing-api";

const S = FrontendI18nKeys.common.myServices;
const N = S.serviceName;

/** The longest name billing takes — a config label's rule (`MAX_CONFIG_LABEL_LENGTH`). */
const MAX_NAME = 40;

/**
 * A service's heading (F-307-x): the buyer's own name for it, with the
 * catalog's name under it, or the catalog's name alone. A pencil edits the
 * name in place: Enter saves, Escape leaves without a write, empty is the
 * catalog's name again, and a refusal keeps what was typed with billing's
 * sentence. The name as saved is kept here, so the page needs no re-read;
 * a later read of the list carries it too.
 */
export function ServiceName({ grantId, label, catalogName }: { grantId: string; label: string | null; catalogName: string | null }) {
  const { t } = useLocale();
  const toMessage = useApiErrorMessage();
  const [saved, setSaved] = useState(label);
  // A re-read of the list that moved the name wins over the one kept here.
  const [seen, setSeen] = useState(label);
  if (label !== seen) {
    setSeen(label);
    setSaved(label);
  }
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fallback = catalogName ?? t("common", S.unnamed);

  function open() {
    setValue(saved ?? "");
    setError(null);
    setEditing(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const name = value.trim();
      const answer = await billingApi.setGrantLabel(grantId, name === "" ? null : name);
      setSaved(answer.label);
      setEditing(false);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  const icon = "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl hover:bg-leaf-bg";

  if (editing) {
    return (
      <form onSubmit={(e) => void save(e)} className="space-y-1">
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
            maxLength={MAX_NAME}
            placeholder={fallback}
            aria-label={t("common", N.field)}
            dir="auto"
            className="min-w-0 flex-1 rounded-xl border border-card-border bg-transparent px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-primary"
          />
          <button type="submit" disabled={saving} aria-label={t("common", N.save)} title={t("common", N.save)} className={`${icon} text-primary`}>
            {saving ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <Check size={18} aria-hidden />}
          </button>
          <button type="button" onClick={() => setEditing(false)} aria-label={t("common", N.cancel)} title={t("common", N.cancel)} className={`${icon} text-text-secondary`}>
            <X size={18} aria-hidden />
          </button>
        </div>
        {error != null ? (
          <p role="alert" className="text-xs font-medium text-error">
            {toMessage(error)}
          </p>
        ) : (
          <p className="text-xs text-text-secondary">{t("common", N.hint)}</p>
        )}
      </form>
    );
  }

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1">
        <h2 className="min-w-0 break-words text-base font-bold text-text-primary" dir="auto">
          {saved ?? fallback}
        </h2>
        <button type="button" onClick={open} aria-label={t("common", N.rename)} title={t("common", N.rename)} className={`${icon} text-text-secondary hover:text-text-primary`}>
          <Pencil size={14} aria-hidden />
        </button>
      </div>
      {saved !== null && <p className="text-xs text-text-secondary">{fallback}</p>}
    </div>
  );
}
