"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BookOpen, ChevronLeft, Languages, Loader2, Package, Pencil, Plus, Power, RotateCw, Tags } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { catalogApi, type CatalogCategory, type CatalogProduct } from "@/lib/catalog-api";
import { PANEL_CATALOG_TRANSLATIONS } from "@/lib/routes";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Select } from "../../_components/kit/Select";
import { CATALOG_KEYS as K, catalogText, featureKeysIn, flattenTexts, isPlatformOwner, type CatalogTexts } from "../_lib/catalog-form";
import { CatalogGuide } from "./CatalogGuide";
import { CategorySheet, NamesSheet } from "./NameSheets";
import { ProductDetailSheet } from "./ProductDetailSheet";
import { ProductWizard } from "./ProductWizard";
import { Alert, primaryButton, quietButton, useMessage } from "./catalog-ui";

/**
 * The published `catalog` namespace in every language locale-service has —
 * an item falls back to its own source language, which may be any of them
 * (F-1533-g). A failure costs the names, never the list: it shows keys.
 */
async function loadTexts(langs: readonly string[]): Promise<CatalogTexts> {
  const entries = await Promise.all(langs.map(async (l) => [l, flattenTexts(await catalogApi.texts(l).catch(() => ({})))] as const));
  return Object.fromEntries(entries);
}

/** Whether this viewer closed the guide. Browser storage can be missing or throw: then the guide just shows. */
const GUIDE_CLOSED = "txnet.catalog.guideClosed";
const readGuideClosed = () => {
  try {
    return localStorage.getItem(GUIDE_CLOSED) === "1";
  } catch {
    return false;
  }
};
const writeGuideClosed = (closed: boolean) => {
  try {
    if (closed) localStorage.setItem(GUIDE_CLOSED, "1");
    else localStorage.removeItem(GUIDE_CLOSED);
  } catch {
    // a per-viewer convenience only
  }
};

type Renaming = { kind: "product" | "category"; id: string; nameKey: string; descriptionKey: string | null; sourceLang: string };

/**
 * The catalog page (F-026-f, D-34): products and categories on two tabs, a
 * guide to what each thing is, and a step-by-step wizard for a new product.
 * Items show their name in the viewer's language, then in their own source
 * language, then their key (F-1533-g, ADR-0050 amendment 2).
 *
 * One page for two audiences, and the page decides neither: billing answers
 * the platform owner every item and a tenant its own. Nothing is patched from a
 * write's answer — the list is re-read — and nothing is deleted: an item or a
 * price is switched off. A price change is always a new row (F-0602).
 */
export function CatalogView() {
  const { t, lang, availableLocales } = useLocale();
  const langCodes = availableLocales.map((l) => l.code).join(",");
  const message = useMessage();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const owner = isPlatformOwner(me);
  const [tab, setTab] = useState<"products" | "categories">("products");
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  // Every product the caller manages: the capability list and the taken keys come from here,
  // whatever the filters show.
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [platformOnly, setPlatformOnly] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"product" | "category" | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [texts, setTexts] = useState<CatalogTexts>({});
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [guide, setGuide] = useState(false);

  useEffect(() => {
    // Storage is only readable in the browser, after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGuide(!readGuideClosed());
  }, []);

  const load = useCallback(async () => {
    try {
      const [cats, prods, names] = await Promise.all([
        catalogApi.categories(),
        catalogApi.products(),
        loadTexts(langCodes ? langCodes.split(",") : [lang]),
      ]);
      setCategories(cats);
      setProducts(prods);
      setTexts(names);
      setError(null);
    } catch (e) {
      setError(e);
    }
    // The review count is a hint beside a link: its failure is not the page's.
    catalogApi.translations().then((d) => setPending(d.length), () => setPending(null));
  }, [lang, langCodes]);

  useEffect(() => {
    // Every setState in load runs after its first await, as in `CouponsView`.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const act = async (run: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await run();
      setNotice(t("common", K.saved));
      await load();
    } catch (e) {
      setActionError(message(e));
    }
  };

  const nameOf = (item: { key: string; nameKey: string; sourceLang: string }) => catalogText(texts, lang, item.nameKey, item.sourceLang) ?? item.key;
  const categoryName = (id: string) => {
    const c = categories.find((x) => x.id === id);
    return c ? nameOf(c) : "—";
  };
  const knownFeatureKeys = useMemo(() => featureKeysIn(products ?? []), [products]);
  const shown = (products ?? []).filter((p) => (!categoryId || p.categoryId === categoryId) && (!platformOnly || p.tenantId === null));
  const countIn = (id: string) => (products ?? []).filter((p) => p.categoryId === id).length;
  const openProduct = products?.find((p) => p.id === openId) ?? null;

  const closeGuide = () => {
    setGuide(false);
    writeGuideClosed(true);
  };
  const saved = async () => {
    setCreating(null);
    setRenaming(null);
    setNotice(t("common", K.saved));
    await load();
  };

  const tabClass = (on: boolean) =>
    `rounded-lg px-3 py-1.5 text-xs font-bold ${on ? "bg-card-bg text-primary shadow-sm" : "text-text-secondary hover:text-text-primary"}`;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-text-primary">
            <Package size={18} className="text-primary" aria-hidden />
            {t("common", K.title)}
          </h1>
          <p className="text-xs text-text-secondary">{t("common", K.subtitle)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!guide && (
            <button
              type="button"
              className={quietButton}
              onClick={() => {
                setGuide(true);
                writeGuideClosed(false);
              }}
            >
              <BookOpen size={14} aria-hidden />
              {t("common", K.guide.show)}
            </button>
          )}
          <Link href={PANEL_CATALOG_TRANSLATIONS} className={quietButton}>
            <Languages size={14} aria-hidden />
            {t("common", K.translations.open)}
            {pending ? (
              <span className="rounded-full bg-primary px-1.5 text-[10px] text-white" title={t("common", K.translationsPending, { count: pending })}>
                {pending}
              </span>
            ) : null}
          </Link>
          <button type="button" className={primaryButton} onClick={() => setCreating("product")}>
            <Plus size={14} aria-hidden />
            {t("common", K.newProduct)}
          </button>
        </div>
      </header>

      {guide && <CatalogGuide onClose={closeGuide} />}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" className="inline-flex gap-1 rounded-xl bg-bg-inner p-1">
          <button type="button" role="tab" aria-selected={tab === "products"} className={tabClass(tab === "products")} onClick={() => setTab("products")}>
            {t("common", K.tabs.products)} {products ? `(${products.length})` : ""}
          </button>
          <button type="button" role="tab" aria-selected={tab === "categories"} className={tabClass(tab === "categories")} onClick={() => setTab("categories")}>
            {t("common", K.tabs.categories)} ({categories.length})
          </button>
        </div>
        {tab === "products" ? (
          <div className="flex flex-wrap gap-2">
            <Select
              ariaLabel={t("common", K.filters.category)}
              value={categoryId}
              onChange={setCategoryId}
              options={[{ value: "", label: t("common", K.filters.allCategories) }, ...categories.map((c) => ({ value: c.id, label: nameOf(c) }))]}
              className="w-44"
            />
            {owner && (
              <Select
                ariaLabel={t("common", K.filters.scope)}
                value={platformOnly ? "platform" : ""}
                onChange={(v) => setPlatformOnly(v === "platform")}
                options={[
                  { value: "", label: t("common", K.filters.scopeAll) },
                  { value: "platform", label: t("common", K.filters.scopePlatform) },
                ]}
                className="w-40"
              />
            )}
          </div>
        ) : (
          <button type="button" className={quietButton} onClick={() => setCreating("category")}>
            <Tags size={14} aria-hidden />
            {t("common", K.newCategory)}
          </button>
        )}
      </div>

      {notice && <p className="text-xs font-bold text-primary">{notice}</p>}
      {actionError && <Alert>{actionError}</Alert>}

      {sessionLoading || (!products && !error) ? (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t("common", K.loading)}
        </p>
      ) : error ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Alert>{message(error)}</Alert>
          <button type="button" className={quietButton} onClick={() => void load()}>
            <RotateCw size={14} aria-hidden />
            {t("common", K.retry)}
          </button>
        </div>
      ) : tab === "products" ? (
        shown.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-text-secondary">{t("common", K.empty)}</p>
            <button type="button" className={primaryButton} onClick={() => setCreating("product")}>
              <Plus size={14} aria-hidden />
              {t("common", K.newProduct)}
            </button>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {shown.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-card-border bg-card-bg p-3 shadow-sm">
                <button type="button" className="min-w-0 flex-1 text-start" onClick={() => setOpenId(p.id)}>
                  <p className="truncate text-sm font-bold text-text-primary">{nameOf(p)}</p>
                  <p className="text-[11px] text-text-secondary">
                    {categoryName(p.categoryId)} · {t("common", K.fulfilmentKind[p.fulfilmentKind])}
                    {p.tenantId === null && ` · ${t("common", K.platform)}`}
                    {!p.isActive && ` · ${t("common", K.inactive)}`}
                  </p>
                  {p.featureKeys.length > 0 && (
                    <p className="mt-1 flex flex-wrap gap-1" dir="ltr">
                      {p.featureKeys.map((k) => (
                        <span key={k} className="rounded-full bg-[var(--leaf-bg)] px-2 py-0.5 font-mono text-[10px] font-bold text-primary">
                          {k}
                        </span>
                      ))}
                    </p>
                  )}
                </button>
                <div className="flex gap-1">
                  <button
                    type="button"
                    className={quietButton}
                    onClick={() => setRenaming({ kind: "product", id: p.id, nameKey: p.nameKey, descriptionKey: p.descriptionKey, sourceLang: p.sourceLang })}
                  >
                    <Pencil size={14} aria-hidden />
                    {t("common", K.rename)}
                  </button>
                  <button type="button" className={quietButton} onClick={() => void act(() => catalogApi.updateProduct(p.id, { isActive: !p.isActive }))}>
                    <Power size={14} aria-hidden />
                    {t("common", p.isActive ? K.deactivate : K.activate)}
                  </button>
                  <button type="button" className={quietButton} onClick={() => setOpenId(p.id)}>
                    {t("common", K.open)}
                    <ChevronLeft size={14} className="ltr:-scale-x-100" aria-hidden />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : categories.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-8">
          <p className="text-sm text-text-secondary">{t("common", K.categories.empty)}</p>
          <button type="button" className={primaryButton} onClick={() => setCreating("category")}>
            <Tags size={14} aria-hidden />
            {t("common", K.newCategory)}
          </button>
        </div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {categories.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-card-border bg-card-bg p-3 shadow-sm">
              <button
                type="button"
                className="min-w-0 flex-1 text-start"
                onClick={() => {
                  setCategoryId(c.id);
                  setTab("products");
                }}
              >
                <p className="truncate text-sm font-bold text-text-primary">{nameOf(c)}</p>
                <p className="text-[11px] text-text-secondary">
                  {t("common", K.categories.products, { count: countIn(c.id) })}
                  {c.tenantId === null && ` · ${t("common", K.platform)}`}
                  {!c.isActive && ` · ${t("common", K.inactive)}`}
                </p>
              </button>
              <div className="flex gap-1">
                <button
                  type="button"
                  className={quietButton}
                  onClick={() => setRenaming({ kind: "category", id: c.id, nameKey: c.nameKey, descriptionKey: null, sourceLang: c.sourceLang })}
                >
                  <Pencil size={14} aria-hidden />
                  {t("common", K.rename)}
                </button>
                <button type="button" className={quietButton} onClick={() => void act(() => catalogApi.updateCategory(c.id, { isActive: !c.isActive }))}>
                  <Power size={14} aria-hidden />
                  {t("common", c.isActive ? K.deactivate : K.activate)}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating === "category" && (
        <CategorySheet owner={owner} takenKeys={categories.map((c) => c.key)} onClose={() => setCreating(null)} onSaved={saved} />
      )}
      {creating === "product" && (
        <ProductWizard
          categories={categories}
          categoryLabel={nameOf}
          takenProductKeys={(products ?? []).map((p) => p.key)}
          takenCategoryKeys={categories.map((c) => c.key)}
          knownFeatureKeys={knownFeatureKeys}
          onClose={() => setCreating(null)}
          onCreated={async (productId, variantFailed) => {
            setCreating(null);
            setTab("products");
            setCategoryId("");
            await load();
            setOpenId(productId);
            if (variantFailed) setActionError(t("common", K.wizard.partial));
            else setNotice(t("common", K.wizard.done));
          }}
        />
      )}
      {openProduct && (
        <ProductDetailSheet
          product={openProduct}
          name={nameOf(openProduct)}
          knownFeatureKeys={knownFeatureKeys}
          onClose={() => setOpenId(null)}
          onChanged={load}
        />
      )}
      {renaming && (
        <NamesSheet
          kind={renaming.kind}
          id={renaming.id}
          nameKey={renaming.nameKey}
          descriptionKey={renaming.descriptionKey}
          texts={texts}
          initialSource={renaming.sourceLang}
          onClose={() => setRenaming(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}
