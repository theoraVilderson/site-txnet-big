"use client";

import { useState } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { CatalogCapability } from "@/lib/catalog-api";
import { DEFAULT_LOCALE } from "@/env";
import { useCatalogSurface } from "../_lib/surface";
import {
  CATALOG_KEYS as K,
  NAME_MAX,
  capabilityBody,
  emptyCapabilityForm,
  suggestCapabilityKey,
  validateCapabilityForm,
  type CapabilityForm,
  type Errors,
} from "../_lib/catalog-form";
import { Alert, Field, KeyField, LanguageSelect, Sheet, input, primaryButton, quietButton, useDirOf, useMessage } from "./catalog-ui";
import { TranslateAllBox } from "./CategoryPickers";

const C = K.capabilities;

/**
 * A capability's fields: its name in a source language and the key made from
 * it (F-114-f-b). `owner` adds "the platform's" — the capabilities tab only; a
 * product's picker files a new one where that product can carry it.
 */
function CapabilityFields({
  form,
  onChange,
  errors,
  takenKeys,
  owner,
}: {
  form: CapabilityForm;
  onChange: (f: CapabilityForm) => void;
  errors: Errors<CapabilityForm>;
  takenKeys: readonly string[];
  owner: boolean;
}) {
  const { t } = useLocale();
  const dirOf = useDirOf();
  const [keyTouched, setKeyTouched] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-text-secondary">{t("common", C.newHint)}</p>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field label={t("common", K.product.sourceLang)} error={errors.sourceLang}>
          <LanguageSelect value={form.sourceLang} onChange={(v) => onChange({ ...form, sourceLang: v })} />
        </Field>
        <Field label={t("common", C.name)} error={errors.name}>
          <input
            className={input}
            dir={dirOf(form.sourceLang)}
            maxLength={NAME_MAX}
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value, key: keyTouched ? form.key : suggestCapabilityKey(e.target.value, takenKeys) })}
          />
        </Field>
      </div>
      <KeyField
        value={form.key}
        error={errors.key}
        onChange={(v) => {
          setKeyTouched(true);
          onChange({ ...form, key: v });
        }}
      />
      {owner && (
        <label className="flex items-center gap-2 text-xs text-text-primary">
          <input type="checkbox" checked={form.shared} onChange={(e) => onChange({ ...form, shared: e.target.checked })} />
          {t("common", C.shared)}
        </label>
      )}
      <TranslateAllBox checked={form.translateAll} onChange={(v) => onChange({ ...form, translateAll: v })} />
    </div>
  );
}

/** Saves a new capability; `tenant` is whose it becomes (`capabilityBody`). The key is refused `key_taken` on the key field. */
function useCreateCapability(tenant: (f: CapabilityForm) => string | null | undefined) {
  const message = useMessage();
  const { api } = useCatalogSurface();
  const [errors, setErrors] = useState<Errors<CapabilityForm>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (form: CapabilityForm): Promise<CatalogCapability | null> => {
    const found = validateCapabilityForm(form);
    setErrors(found);
    if (Object.keys(found).length) return null;
    setBusy(true);
    setError(null);
    try {
      return await api.createCapability(capabilityBody(form, tenant(form)));
    } catch (e) {
      if ((e as { reason?: unknown } | null)?.reason === "key_taken") setErrors({ key: K.refusals.key_taken });
      setError(message(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { errors, busy, error, create };
}

/** "New capability" on the capabilities tab: the caller's own, or — the platform owner ticking it — the platform's. */
export function CapabilitySheet({
  owner,
  takenKeys,
  onClose,
  onSaved,
}: {
  owner: boolean;
  takenKeys: readonly string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [form, setForm] = useState<CapabilityForm>(() => emptyCapabilityForm(DEFAULT_LOCALE));
  const { errors, busy, error, create } = useCreateCapability((f) => (owner && f.shared ? null : undefined));
  const save = async () => {
    if (await create(form)) await onSaved();
  };
  return (
    <Sheet title={t("common", C.new)} onClose={onClose}>
      <CapabilityFields form={form} onChange={setForm} errors={errors} takenKeys={takenKeys} owner={owner} />
      {error && <Alert>{error}</Alert>}
      <div className="flex justify-end gap-2">
        <button type="button" className={quietButton} onClick={onClose}>
          {t("common", K.cancel)}
        </button>
        <button type="button" className={primaryButton} disabled={busy} onClick={() => void save()}>
          {t("common", K.save)}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * A product's capabilities, ticked by name from billing's list (F-114-f-b,
 * ADR-0086) — never a key typed by hand. `options` is what this product may
 * carry (`capabilitiesFor`); a key ticked that is not among them (the owner
 * moved the product to another tenant) is shown as such, to be taken off.
 *
 * "New capability" asks a name, derives the key, files it under `newTenant`
 * — the product's tenant, so the product can carry it — and ticks it once
 * `onCreated` has re-read the list.
 */
export function CapabilityPicker({
  value,
  onChange,
  options,
  label,
  takenKeys,
  newTenant,
  onCreated,
  error,
}: {
  value: string[];
  onChange: (keys: string[]) => void;
  options: readonly CatalogCapability[];
  label: (c: CatalogCapability) => string;
  /** Every key the caller sees, so a derived one is numbered past them. */
  takenKeys: readonly string[];
  newTenant: string | null | undefined;
  onCreated: () => Promise<void>;
  error?: string;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<CapabilityForm | null>(null);
  const creating = useCreateCapability(() => newTenant);
  const typed = query.trim().toLowerCase();
  const shown = typed ? options.filter((c) => label(c).toLowerCase().includes(typed) || c.key.includes(typed)) : options;
  const offered = new Set(options.map((c) => c.key));
  const stray = value.filter((k) => !offered.has(k));
  const toggle = (k: string) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  const startAdding = () => {
    const name = query.trim();
    setAdding({ ...emptyCapabilityForm(DEFAULT_LOCALE), name, key: name ? suggestCapabilityKey(name, takenKeys) : "" });
  };
  const add = async () => {
    if (!adding) return;
    const made = await creating.create(adding);
    if (!made) return;
    await onCreated();
    onChange([...value, made.key]);
    setAdding(null);
    setQuery("");
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-bold text-text-secondary">{t("common", C.label)}</p>
      <p className="text-[11px] text-text-secondary">{t("common", C.hint)}</p>
      {options.length > 0 && (
        <input
          className={input}
          value={query}
          placeholder={t("common", C.search)}
          aria-label={t("common", C.search)}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (shown.length === 1) toggle(shown[0].key);
            }
          }}
        />
      )}
      {options.length === 0 && <p className="text-[11px] text-text-secondary">{t("common", C.empty)}</p>}
      <div className="flex flex-wrap gap-1.5">
        {shown.map((c) => {
          const on = value.includes(c.key);
          const name = label(c);
          return (
            <button
              key={c.id}
              type="button"
              title={c.key}
              aria-pressed={on}
              onClick={() => toggle(c.key)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold ${
                on ? "border-primary bg-primary text-white" : "border-card-border bg-bg-inner text-text-primary hover:border-primary"
              }`}
            >
              {on ? <Check size={12} aria-hidden /> : null}
              {name}
              {on ? <X size={12} aria-label={t("common", C.remove, { name })} /> : null}
            </button>
          );
        })}
        {stray.map((k) => (
          <button
            key={k}
            type="button"
            dir="ltr"
            title={t("common", C.notOffered)}
            onClick={() => toggle(k)}
            className="inline-flex items-center gap-1 rounded-full border border-error px-2.5 py-1 font-mono text-[11px] font-bold text-error"
          >
            {k}
            <X size={12} aria-label={t("common", C.remove, { name: k })} />
          </button>
        ))}
        {!adding && (
          <button
            type="button"
            onClick={startAdding}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-primary px-2.5 py-1 text-[11px] font-bold text-primary"
          >
            <Plus size={12} aria-hidden />
            {query.trim() ? t("common", C.add, { name: query.trim() }) : t("common", C.new)}
          </button>
        )}
      </div>
      {stray.length > 0 && <p className="text-[11px] text-error">{t("common", C.notOffered)}</p>}
      {adding && (
        <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-primary p-3">
          <CapabilityFields form={adding} onChange={setAdding} errors={creating.errors} takenKeys={takenKeys} owner={false} />
          {creating.error && <Alert>{creating.error}</Alert>}
          <div className="flex justify-end gap-2">
            <button type="button" className={quietButton} onClick={() => setAdding(null)}>
              {t("common", K.cancel)}
            </button>
            <button type="button" className={primaryButton} disabled={creating.busy} onClick={() => void add()}>
              {creating.busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Plus size={14} aria-hidden />}
              {t("common", C.create)}
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-[11px] text-error">{t("common", error)}</p>}
    </div>
  );
}
