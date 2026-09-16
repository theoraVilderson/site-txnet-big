"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { Select } from "../../_components/kit/Select";
import { CATALOG_KEYS as K, refusalKey } from "../_lib/catalog-form";

/** The pieces every catalog sheet and the wizard share. */

export const input = "w-full rounded-xl border border-card-border bg-bg-inner px-3 py-2 text-sm text-text-primary outline-none focus:border-primary";
export const primaryButton = "inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-bold text-white shadow-sm disabled:opacity-50";
export const quietButton = "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-primary hover:bg-[var(--leaf-bg)] disabled:opacity-50";

/** The refusal's own sentence, else the generic answer for that error. */
export function useMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}

/** Every language locale-service has, as a picker: the source language of a name. */
export function LanguageSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { availableLocales } = useLocale();
  return <Select value={value} onChange={onChange} options={availableLocales.map((l) => ({ value: l.code, label: l.name }))} />;
}

/** A language's writing direction, from locale-service's metadata. */
export function useDirOf() {
  const { availableLocales } = useLocale();
  return (code: string) => availableLocales.find((l) => l.code === code)?.dir ?? "ltr";
}

export function Sheet({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const { t } = useLocale();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-6" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-t-3xl border border-card-border bg-card-bg shadow-xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 border-b border-card-border p-4">
          <h2 className="text-sm font-bold text-text-primary">{title}</h2>
          <button type="button" onClick={onClose} aria-label={t("common", K.close)} className="rounded-lg p-1 text-text-secondary hover:text-text-primary">
            <X size={18} aria-hidden />
          </button>
        </header>
        <div className="flex flex-col gap-4 overflow-y-auto p-4">{children}</div>
        {footer && <footer className="border-t border-card-border p-4">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  const { t } = useLocale();
  return (
    <label className="flex flex-col gap-1 text-xs font-bold text-text-secondary">
      {label}
      {children}
      {hint && !error && <span className="text-[11px] font-normal">{hint}</span>}
      {error && <span className="text-[11px] text-error">{t("common", error)}</span>}
    </label>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-xs font-bold text-error">
      {children}
    </p>
  );
}

/**
 * The internal key, made from the name: shown, not asked for. "Change key"
 * opens the box for the rare admin who wants their own; a refusal on the key
 * opens it too.
 */
export function KeyField({ value, onChange, error, forceOpen }: { value: string; onChange: (v: string) => void; error?: string; forceOpen?: boolean }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  if (open || forceOpen || error) {
    return (
      <Field label={t("common", K.product.key)} error={error} hint={t("common", K.wizard.keyHint)}>
        <input className={input} dir="ltr" value={value} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
      <span>
        {t("common", K.wizard.key, { key: "" })}
        <span dir="ltr" className="font-mono">
          {value || t("common", K.wizard.none)}
        </span>
      </span>
      <button type="button" className={quietButton} onClick={() => setOpen(true)}>
        {t("common", K.wizard.editKey)}
      </button>
    </p>
  );
}

/** A variant's id, which a free-service coupon names (F-502-l-c): one click to copy, not a line to select. */
export function CopyId({ id }: { id: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={quietButton}
      title={id}
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      {t("common", copied ? K.copied : K.copyId)}
    </button>
  );
}
