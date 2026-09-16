"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { catalogApi } from "@/lib/catalog-api";
import { DEFAULT_LOCALE } from "@/env";
import {
  CATALOG_KEYS as K,
  DESCRIPTION_MAX,
  NAME_MAX,
  categoryBody,
  emptyCategoryForm,
  namesBody,
  suggestKey,
  validateCategoryForm,
  validateNamesForm,
  type CatalogTexts,
  type CategoryForm,
  type Errors,
  type NamesForm,
} from "../_lib/catalog-form";
import { Alert, Field, KeyField, LanguageSelect, Sheet, input, primaryButton, quietButton, useDirOf, useMessage } from "./catalog-ui";

/**
 * A category's fields: the name in its source language, the key made from it.
 * Shared by "new category" and the wizard's first step.
 */
export function CategoryFields({
  form,
  onChange,
  errors,
  takenKeys,
  owner,
}: {
  form: CategoryForm;
  onChange: (f: CategoryForm) => void;
  errors: Errors<CategoryForm>;
  takenKeys: readonly string[];
  owner: boolean;
}) {
  const { t } = useLocale();
  const dirOf = useDirOf();
  const [keyTouched, setKeyTouched] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field label={t("common", K.category.sourceLang)} error={errors.sourceLang}>
          <LanguageSelect value={form.sourceLang} onChange={(v) => onChange({ ...form, sourceLang: v })} />
        </Field>
        <Field label={t("common", K.category.name)} error={errors.name} hint={t("common", K.product.nameHint)}>
          <input
            className={input}
            dir={dirOf(form.sourceLang)}
            maxLength={NAME_MAX}
            value={form.name}
            onChange={(e) =>
              onChange({ ...form, name: e.target.value, key: keyTouched ? form.key : suggestKey(e.target.value, takenKeys, "category") })
            }
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
          {t("common", K.category.shared)}
        </label>
      )}
    </div>
  );
}

export function CategorySheet({
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
  const message = useMessage();
  const [form, setForm] = useState<CategoryForm>(() => emptyCategoryForm(DEFAULT_LOCALE));
  const [errors, setErrors] = useState<Errors<CategoryForm>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const found = validateCategoryForm(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setError(null);
    try {
      await catalogApi.createCategory(categoryBody(form, owner));
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={t("common", K.newCategory)} onClose={onClose}>
      <p className="text-[11px] text-text-secondary">{t("common", K.guide.category.body)}</p>
      <CategoryFields form={form} onChange={setForm} errors={errors} takenKeys={takenKeys} owner={owner} />
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
 * Renames an existing item in the source language picked (F-1533-g). Picking
 * another language shows its published text, if any; billing re-keys the item
 * and drafts every other language from the new source.
 */
export function NamesSheet({
  kind,
  id,
  nameKey,
  descriptionKey,
  texts,
  initialSource,
  onClose,
  onSaved,
}: {
  kind: "product" | "category";
  id: string;
  nameKey: string;
  descriptionKey: string | null;
  texts: CatalogTexts;
  initialSource: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLocale();
  const message = useMessage();
  const dirOf = useDirOf();
  const textsIn = (lang: string): NamesForm => ({
    sourceLang: lang,
    name: texts[lang]?.[nameKey] ?? "",
    description: (descriptionKey && texts[lang]?.[descriptionKey]) || "",
  });
  const [form, setForm] = useState<NamesForm>(() => textsIn(initialSource));
  const [errors, setErrors] = useState<Errors<NamesForm>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof NamesForm, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const found = validateNamesForm(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "product") await catalogApi.updateProduct(id, namesBody(form, "product"));
      else await catalogApi.updateCategory(id, namesBody(form, "category"));
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const P = K.product;
  const dir = dirOf(form.sourceLang);
  return (
    <Sheet title={t("common", K.rename)} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field label={t("common", P.sourceLang)} error={errors.sourceLang}>
          <LanguageSelect value={form.sourceLang} onChange={(v) => setForm(textsIn(v))} />
        </Field>
        <Field label={t("common", P.name)} error={errors.name} hint={t("common", P.nameHint)}>
          <input className={input} dir={dir} maxLength={NAME_MAX} value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
      </div>
      {kind === "product" && (
        <Field label={t("common", P.description)}>
          <textarea className={input} dir={dir} rows={3} maxLength={DESCRIPTION_MAX} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
      )}
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
