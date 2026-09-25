"use client";

import { useState } from "react";
import { Check, Pencil } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { CatalogCategory, CatalogProduct } from "@/lib/catalog-api";
import { useCatalogSurface } from "../_lib/surface";
import { Select } from "../../_components/kit/Select";
import { CATALOG_KEYS as K, categoryPath, categoryTree, moveBody, parentChoices } from "../_lib/catalog-form";
import { Alert, Field, Sheet, primaryButton, quietButton, useMessage } from "./catalog-ui";

/**
 * Categories as a tree (F-026-s over F-026-r): the parent picker, the
 * several-categories picker a product is filed with, and the "translate into
 * every language" box (F-1533-i). Billing refuses a cycle and a fourth level;
 * the pickers never offer one (`parentChoices`).
 */

type Label = (c: CatalogCategory) => string;

/** A category's parent: none (top level), or any place `parentChoices` allows. `self` = the category being moved. */
export function ParentSelect({
  categories,
  self,
  label,
  value,
  onChange,
}: {
  categories: readonly CatalogCategory[];
  self: string | null;
  label: Label;
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useLocale();
  return (
    <Select
      ariaLabel={t("common", K.category.parent)}
      value={value}
      onChange={onChange}
      options={[
        { value: "", label: t("common", K.category.top) },
        ...parentChoices(categories, self).map((c) => ({ value: c.id, label: categoryPath(categories, c.id, label) })),
      ]}
    />
  );
}

/** Every category as a tree; each click adds or removes one, and the order picked is the order sent. */
export function CategoryMultiPicker({
  categories,
  label,
  value,
  onChange,
}: {
  categories: readonly CatalogCategory[];
  label: Label;
  value: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useLocale();
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <ul className="flex flex-col gap-1.5">
      {categoryTree(categories).map(({ category: c, depth }) => {
        const at = value.indexOf(c.id);
        return (
          <li key={c.id} style={{ marginInlineStart: `${depth * 1.25}rem` }}>
            <button
              type="button"
              aria-pressed={at >= 0}
              onClick={() => toggle(c.id)}
              className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-start text-sm text-text-primary ${
                at >= 0 ? "border-primary bg-[var(--leaf-bg)] ring-1 ring-primary" : "border-card-border bg-bg-inner hover:border-primary"
              }`}
            >
              <span
                className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                  at >= 0 ? "bg-primary text-white" : "border border-card-border"
                }`}
              >
                {at >= 0 ? at + 1 : ""}
              </span>
              <span className="font-bold">{label(c)}</span>
              {!c.isActive && <span className="text-[11px] text-text-secondary">· {t("common", K.inactive)}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Off by default: only the language written changes, and the others fall back to it (F-1533-i). */
export function TranslateAllBox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const { t } = useLocale();
  return (
    <label className="flex items-start gap-2 rounded-xl bg-bg-inner p-3 text-xs text-text-primary">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="flex flex-col gap-0.5">
        <span className="font-bold">{t("common", K.product.translateAll)}</span>
        <span className="text-[11px] text-text-secondary">{t("common", K.product.translateAllHint)}</span>
      </span>
    </label>
  );
}

/** Moves a category under another, or to the top. */
export function MoveCategorySheet({
  category,
  categories,
  label,
  onClose,
  onSaved,
}: {
  category: CatalogCategory;
  categories: readonly CatalogCategory[];
  label: Label;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLocale();
  const message = useMessage();
  const { api } = useCatalogSurface();
  const [parentId, setParentId] = useState(category.parentId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateCategory(category.id, moveBody(parentId));
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={`${t("common", K.categories.moveTitle)}: ${label(category)}`} onClose={onClose}>
      <Field label={t("common", K.category.parent)} hint={t("common", K.category.parentHint)}>
        <ParentSelect categories={categories} self={category.id} label={label} value={parentId} onChange={setParentId} />
      </Field>
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

/** The categories a product is filed in, and a change to them — a patch replaces the whole list (F-026-r). */
export function ProductCategories({
  product,
  categories,
  label,
  onSaved,
}: {
  product: CatalogProduct;
  categories: readonly CatalogCategory[];
  label: Label;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLocale();
  const message = useMessage();
  const { api } = useCatalogSurface();
  const [editing, setEditing] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = (id: string) => (categories.some((c) => c.id === id) ? categoryPath(categories, id, label) : "—");

  const save = async () => {
    if (!editing || editing.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateProduct(product.id, { categoryIds: editing });
      setEditing(null);
      await onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-2 rounded-2xl border border-card-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold text-text-secondary">{t("common", K.product.categories)}</h3>
        {!editing && (
          <button type="button" className={quietButton} onClick={() => setEditing([...product.categoryIds])}>
            <Pencil size={14} aria-hidden />
            {t("common", K.product.editCategories)}
          </button>
        )}
      </div>
      {editing ? (
        <>
          <p className="text-[11px] text-text-secondary">{t("common", K.product.categoriesHint)}</p>
          <CategoryMultiPicker categories={categories} label={label} value={editing} onChange={setEditing} />
          {editing.length === 0 && <p className="text-[11px] text-error">{t("common", K.wizard.pickCategory)}</p>}
          {error && <Alert>{error}</Alert>}
          <div className="flex justify-end gap-2">
            <button type="button" className={quietButton} onClick={() => setEditing(null)}>
              {t("common", K.cancel)}
            </button>
            <button type="button" className={primaryButton} disabled={busy || editing.length === 0} onClick={() => void save()}>
              <Check size={14} aria-hidden />
              {t("common", K.save)}
            </button>
          </div>
        </>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {product.categoryIds.map((id) => (
            <li key={id} className="rounded-full bg-[var(--leaf-bg)] px-2.5 py-0.5 text-[11px] font-bold text-primary">
              {path(id)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
