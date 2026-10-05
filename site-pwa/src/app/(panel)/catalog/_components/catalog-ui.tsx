"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { Alert as KitAlert, Button, Dialog, Input } from "../../_components/kit";
import { Select } from "../../_components/kit/Select";
import { CATALOG_KEYS as K, refusalKey } from "../_lib/catalog-form";
import { useCatalogSurface } from "../_lib/surface";

/** The pieces every catalog sheet and the wizard share. */

/**
 * The refusal's own sentence, else the generic answer for that error. The
 * surface answers first: a reseller's screen has its own wording for the same
 * reasons, and for the two doors the ambient page never meets (F-066-w8).
 */
export function useMessage() {
  const { t } = useLocale();
  const surface = useCatalogSurface();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = surface.refusalKey?.(e) ?? refusalKey(e);
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

/**
 * A catalog sheet: the kit's `Dialog` at its wide size (contract.ux.md K7) —
 * Esc and the backdrop close it, focus is trapped and returned, the page is
 * locked. Mounted while open; the caller decides what closing a dirty form asks.
 */
export function Sheet({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <Dialog open size="lg" title={title} onClose={onClose} footer={footer}>
      <div className="flex flex-col gap-4">{children}</div>
    </Dialog>
  );
}

/**
 * A labelled control, the refusal given as a catalog key, in the kit `Field`'s
 * type. The `<label>` wraps the control rather than naming it by id: its
 * children include whole pickers (`DatePicker`, `ParentSelect`, `OwnerPicker`,
 * `ChoicePicker`, `VariantPicker`) that are not one kit control, and a wrapping
 * label names whatever is inside (contract.ux.md R5).
 */
export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  const { t } = useLocale();
  return (
    <label className="flex flex-col gap-1.5 text-sm font-bold text-text-primary">
      {label}
      {children}
      {hint && !error && <span className="text-xs font-normal text-text-secondary">{hint}</span>}
      {error && <span className="text-xs font-normal text-error">{t("common", error)}</span>}
    </label>
  );
}

/** A failure line under a form: the kit's error `Alert` (K6). */
export function Alert({ children }: { children: ReactNode }) {
  return <KitAlert tone="error">{children}</KitAlert>;
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
        <Input dir="ltr" value={value} onChange={(e) => onChange(e.target.value)} />
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
      <Button variant="quiet" size="sm" onClick={() => setOpen(true)}>
        {t("common", K.wizard.editKey)}
      </Button>
    </p>
  );
}

/** A variant's id, which a free-service coupon names (F-502-l-c): one click to copy, not a line to select. */
export function CopyId({ id }: { id: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="quiet"
      size="sm"
      title={id}
      icon={copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {t("common", copied ? K.copied : K.copyId)}
    </Button>
  );
}
