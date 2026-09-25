"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Archive, BookOpen, ChevronLeft, Languages, Loader2, Package, Pencil, Plus, Power, RotateCcw, RotateCw, Tags, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { type CatalogAdminApi, type CatalogCategory, type CatalogProduct } from "@/lib/catalog-api";
import { useCatalogSurface } from "../_lib/surface";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Select } from "../../_components/kit/Select";
import {
  CATALOG_KEYS as K,
  catalogText,
  categoryRemovalReport,
  featureKeysIn,
  flattenTexts,
  isPlatformOwner,
  productCounts,
  removalReport,
  stillSelected,
  surfaceActor,
  switchReport,
  switchTargets,
  type CatalogTexts,
} from "../_lib/catalog-form";
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
async function loadTexts(api: CatalogAdminApi, langs: readonly string[]): Promise<CatalogTexts> {
  const entries = await Promise.all(langs.map(async (l) => [l, flattenTexts(await api.texts(l).catch(() => ({})))] as const));
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
 * write's answer — the list is re-read. An item or a price is switched off; the
 * deletes are group removals: of products (F-026-i), where billing deletes a
 * product never sold and archives a sold one — the page shows what it did, and
 * the archived behind their own toggle — and of categories (F-026-k), where an
 * empty one goes and one holding products stays. A price change is always a new row (F-0602).
 */
export function CatalogView() {
  const { t, lang, availableLocales } = useLocale();
  const langCodes = availableLocales.map((l) => l.code).join(",");
  const message = useMessage();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const surface = useCatalogSurface();
  const { api } = surface;
  // Nobody is an owner on a reseller's screen: billing runs the work as the
  // reseller and refuses a platform item there, whoever is signed in (F-066-w8).
  const owner = isPlatformOwner(surfaceActor(me, surface.tenantId));
  const [tab, setTab] = useState<"products" | "categories">("products");
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  // Every product the caller manages: the capability list and the taken keys come from here,
  // whatever the filters show.
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  // Sold products a removal kept (F-026-h): out of the list, still holding their keys.
  const [archived, setArchived] = useState<CatalogProduct[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState(false);
  // The categories tab has its own selection (F-026-k): a tab switch never carries one into the other.
  const [pickedCategories, setPickedCategories] = useState<Set<string>>(new Set());
  const [switching, setSwitching] = useState(false);
  const [report, setReport] = useState<{ key: string; count: number }[]>([]);
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
      const [cats, prods, kept, names] = await Promise.all([
        api.categories(),
        api.products(),
        api.products({ archived: "true" }),
        loadTexts(api, langCodes ? langCodes.split(",") : [lang]),
      ]);
      setCategories(cats);
      setProducts(prods);
      setArchived(kept);
      setSelected((before) => stillSelected(before, prods));
      setPickedCategories((before) => stillSelected(before, cats));
      setTexts(names);
      setError(null);
    } catch (e) {
      setError(e);
    }
    // The review count is a hint beside a link: its failure is not the page's.
    api.translations().then((d) => setPending(d.length), () => setPending(null));
  }, [api, lang, langCodes]);

  useEffect(() => {
    // Every setState in load runs after its first await, as in `CouponsView`.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const act = async (run: () => Promise<unknown>) => {
    setActionError(null);
    setReport([]);
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
  const listed = showArchived ? archived : (products ?? []);
  const shown = listed.filter((p) => (!categoryId || p.categoryId === categoryId) && (!platformOnly || p.tenantId === null));
  const allSelected = !showArchived && shown.length > 0 && shown.every((p) => selected.has(p.id));
  const toggle = (id: string) =>
    setSelected((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const removeSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0 || !window.confirm(t("common", K.removal.confirm, { count: ids.length }))) return;
    setRemoving(true);
    setActionError(null);
    setNotice(null);
    try {
      setReport(removalReport(await api.removeProducts(ids)));
      setSelected(new Set());
      await load();
    } catch (e) {
      setActionError(message(e));
    } finally {
      setRemoving(false);
    }
  };
  // Archived products count: billing keeps a category any of them sits in (F-026-j).
  const counts = useMemo(() => productCounts(products ?? [], archived), [products, archived]);
  const allCategoriesPicked = categories.length > 0 && categories.every((c) => pickedCategories.has(c.id));
  const pickCategory = (id: string) =>
    setPickedCategories((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const removeCategories = async () => {
    const ids = [...pickedCategories];
    if (ids.length === 0 || !window.confirm(t("common", K.categories.confirm, { count: ids.length }))) return;
    setRemoving(true);
    setActionError(null);
    setNotice(null);
    try {
      setReport(categoryRemovalReport(await api.removeCategories(ids)));
      setPickedCategories(new Set());
      await load();
    } catch (e) {
      setActionError(message(e));
    } finally {
      setRemoving(false);
    }
  };
  // One PATCH per category that changes, each on its own; the list is read once after all of them.
  const switchCategories = async (on: boolean) => {
    const ids = switchTargets(pickedCategories, categories, on);
    setSwitching(true);
    setActionError(null);
    setNotice(null);
    try {
      setReport(switchReport(await Promise.allSettled(ids.map((id) => api.updateCategory(id, { isActive: on })))));
      await load();
    } finally {
      setSwitching(false);
    }
  };
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
      {surface.chrome}
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
          <Link href={surface.translationsHref} className={quietButton}>
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
            {(archived.length > 0 || showArchived) && (
              <button
                type="button"
                className={quietButton}
                aria-pressed={showArchived}
                onClick={() => {
                  setShowArchived(!showArchived);
                  setSelected(new Set());
                }}
              >
                <Archive size={14} aria-hidden />
                {showArchived ? t("common", K.removal.showActive) : t("common", K.removal.showArchived, { count: archived.length })}
              </button>
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
      {report.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs font-bold text-primary" role="status">
          {report.map((line) => (
            <li key={line.key}>{t("common", line.key, { count: line.count })}</li>
          ))}
        </ul>
      )}
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
      ) : tab === "products" && showArchived ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-secondary">{t("common", K.removal.archivedHint)}</p>
          {shown.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-secondary">{t("common", K.removal.archivedEmpty)}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {shown.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-card-border bg-card-bg p-3 opacity-80 shadow-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-text-primary">{nameOf(p)}</p>
                    <p className="text-[11px] text-text-secondary">
                      {categoryName(p.categoryId)} · {t("common", K.removal.archivedBadge)}
                      {p.tenantId === null && ` · ${t("common", K.platform)}`}
                    </p>
                  </div>
                  <button type="button" className={quietButton} onClick={() => void act(() => api.updateProduct(p.id, { archived: false }))}>
                    <RotateCcw size={14} aria-hidden />
                    {t("common", K.removal.restore)}
                  </button>
                </li>
              ))}
            </ul>
          )}
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
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3 px-1 text-xs">
              <label className="flex items-center gap-2 font-bold text-text-primary">
                <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(shown.map((p) => p.id)))} />
                {t("common", K.removal.selectAll)}
              </label>
              {selected.size > 0 && (
                <>
                  <span className="text-text-secondary">{t("common", K.removal.selected, { count: selected.size })}</span>
                  <button
                    type="button"
                    disabled={removing}
                    onClick={() => void removeSelected()}
                    className="inline-flex items-center gap-1 rounded-xl border border-error-border px-2.5 py-1 font-bold text-error hover:bg-error-bg disabled:opacity-50"
                  >
                    {removing ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
                    {t("common", removing ? K.removal.removing : K.removal.remove)}
                  </button>
                </>
              )}
            </div>
            <ul className="flex flex-col gap-2">
              {shown.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-card-border bg-card-bg p-3 shadow-sm">
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={nameOf(p)} />
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
                  <button type="button" className={quietButton} onClick={() => void act(() => api.updateProduct(p.id, { isActive: !p.isActive }))}>
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
          </div>
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
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3 px-1 text-xs">
            <label className="flex items-center gap-2 font-bold text-text-primary">
              <input
                type="checkbox"
                checked={allCategoriesPicked}
                onChange={() => setPickedCategories(allCategoriesPicked ? new Set() : new Set(categories.map((c) => c.id)))}
              />
              {t("common", K.removal.selectAll)}
            </label>
            {pickedCategories.size > 0 && (
              <>
                <span className="text-text-secondary">{t("common", K.categories.selected, { count: pickedCategories.size })}</span>
                <button type="button" className={quietButton} disabled={switching || removing} onClick={() => void switchCategories(true)}>
                  <Power size={14} aria-hidden />
                  {t("common", K.categories.switchOn)}
                </button>
                <button type="button" className={quietButton} disabled={switching || removing} onClick={() => void switchCategories(false)}>
                  <Power size={14} aria-hidden />
                  {t("common", K.categories.switchOff)}
                </button>
                <button
                  type="button"
                  disabled={switching || removing}
                  onClick={() => void removeCategories()}
                  className="inline-flex items-center gap-1 rounded-xl border border-error-border px-2.5 py-1 font-bold text-error hover:bg-error-bg disabled:opacity-50"
                >
                  {removing ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
                  {t("common", removing ? K.removal.removing : K.removal.remove)}
                </button>
              </>
            )}
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {categories.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-card-border bg-card-bg p-3 shadow-sm">
                <input type="checkbox" checked={pickedCategories.has(c.id)} onChange={() => pickCategory(c.id)} aria-label={nameOf(c)} />
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
                    {t("common", K.categories.products, { count: counts.get(c.id) ?? 0 })}
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
                  <button type="button" className={quietButton} onClick={() => void act(() => api.updateCategory(c.id, { isActive: !c.isActive }))}>
                    <Power size={14} aria-hidden />
                    {t("common", c.isActive ? K.deactivate : K.activate)}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {creating === "category" && (
        <CategorySheet owner={owner} takenKeys={categories.map((c) => c.key)} onClose={() => setCreating(null)} onSaved={saved} />
      )}
      {creating === "product" && (
        <ProductWizard
          categories={categories}
          categoryLabel={nameOf}
          takenProductKeys={[...(products ?? []), ...archived].map((p) => p.key)}
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
