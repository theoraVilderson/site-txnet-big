"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Archive, BookOpen, ChevronLeft, FolderTree, Languages, Loader2, Package, Pencil, Plus, Power, RotateCcw, RotateCw, Tags, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { type CatalogAdminApi, type CatalogCapability, type CatalogCategory, type CatalogProduct } from "@/lib/catalog-api";
import { useCatalogSurface } from "../_lib/surface";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Select } from "../../_components/kit/Select";
import {
  CATALOG_KEYS as K,
  afterWizard,
  catalogText,
  categoryPath,
  categoryTree,
  categoryRemovalReport,
  heldByProducts,
  mergeRemovals,
  flattenTexts,
  isPlatformOwner,
  productCounts,
  removalReport,
  RESTORE_CATEGORY,
  stillSelected,
  surfaceActor,
  switchReport,
  switchTargets,
  type CatalogTexts,
} from "../_lib/catalog-form";
import { CapabilitiesTab } from "./CapabilitiesTab";
import { CapabilitySheet } from "./CapabilityPicker";
import { CatalogGuide } from "./CatalogGuide";
import { CategorySheet, NamesSheet } from "./NameSheets";
import { MoveCategorySheet } from "./CategoryPickers";
import { ProductDetailSheet } from "./ProductDetailSheet";
import { ProductWizard } from "./ProductWizard";
import { useMessage } from "./catalog-ui";
import { PageHeader } from "../../_components/kit/PageHeader";
import { Alert, Button, buttonClass, Checkbox, Tabs, useConfirm } from "../../_components/kit";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

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

type Renaming = { kind: "product" | "category" | "capability"; id: string; nameKey: string; descriptionKey: string | null; sourceLang: string };

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
  const confirm = useConfirm();
  const langCodes = availableLocales.map((l) => l.code).join(",");
  const message = useMessage();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const surface = useCatalogSurface();
  const { api } = surface;
  // Nobody is an owner on a reseller's screen: billing runs the work as the
  // reseller and refuses a platform item there, whoever is signed in (F-066-w8).
  const owner = isPlatformOwner(surfaceActor(me, surface.tenantId));
  const [tab, setTab] = useState<"products" | "categories" | "capabilities">("products");
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  // Categories archived with their sold products (F-026-l): out of the tab, still naming those products.
  const [archivedCategories, setArchivedCategories] = useState<CatalogCategory[]>([]);
  const [showArchivedCategories, setShowArchivedCategories] = useState(false);
  // What a product may unlock (F-114-f-b): the platform's and the caller's own, every one for the owner.
  const [capabilities, setCapabilities] = useState<CatalogCapability[]>([]);
  // Every product the caller manages: the taken keys come from here, whatever the filters show.
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
  const [creating, setCreating] = useState<"product" | "category" | "capability" | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // The product the wizard just made (F-114-g): marked in the list, offered from the notice.
  const [freshId, setFreshId] = useState<string | null>(null);
  const [texts, setTexts] = useState<CatalogTexts>({});
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [moving, setMoving] = useState<CatalogCategory | null>(null);
  const [guide, setGuide] = useState(false);

  useEffect(() => {
    // Storage is only readable in the browser, after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGuide(!readGuideClosed());
  }, []);

  const load = useCallback(async () => {
    try {
      const [cats, keptCats, prods, kept, caps, names] = await Promise.all([
        api.categories(),
        api.categories({ archived: "true" }),
        api.products(),
        api.products({ archived: "true" }),
        api.capabilities(),
        loadTexts(api, langCodes ? langCodes.split(",") : [lang]),
      ]);
      setCategories(cats);
      setArchivedCategories(keptCats);
      setProducts(prods);
      setArchived(kept);
      setCapabilities(caps);
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
  // A product sits in several categories (F-026-r): each named by its path from the top, first first.
  const categoryName = (id: string) => {
    const all = [...categories, ...archivedCategories];
    return all.some((x) => x.id === id) ? categoryPath(all, id, nameOf) : "—";
  };
  const categoryNames = (ids: readonly string[]) => ids.map(categoryName).join("، ");
  const tree = useMemo(() => categoryTree(categories), [categories]);
  const capabilityName = (k: string) => {
    const c = capabilities.find((x) => x.key === k);
    return c ? nameOf(c) : k;
  };
  const listed = showArchived ? archived : (products ?? []);
  const shown = listed.filter((p) => (!categoryId || p.categoryIds.includes(categoryId)) && (!platformOnly || p.tenantId === null));
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
    if (ids.length === 0 || !(await confirm({ title: t("common", K.removal.confirm, { count: ids.length }), confirmLabel: t("common", FrontendI18nKeys.common.kit.confirm.delete), tone: "danger" }))) return;
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
    if (ids.length === 0 || !(await confirm({ title: t("common", K.categories.confirm, { count: ids.length }), confirmLabel: t("common", FrontendI18nKeys.common.kit.confirm.delete), tone: "danger" }))) return;
    setRemoving(true);
    setActionError(null);
    setNotice(null);
    try {
      // Billing keeps a category with products in it; only then, and only for those, the page asks again (F-026-m).
      let outcomes = await api.removeCategories(ids);
      const held = heldByProducts(outcomes);
      // K9: products go with them, so the name is typed — one category's own, or how many.
      const typeToConfirm = held.length === 1 ? categoryName(held[0]) : String(held.length);
      if (
        held.length > 0 &&
        (await confirm({ title: t("common", K.categories.confirmWithProducts, { count: held.length }), confirmLabel: t("common", FrontendI18nKeys.common.kit.confirm.delete), tone: "danger", typeToConfirm }))
      ) {
        outcomes = mergeRemovals(outcomes, await api.removeCategories(held, true));
      }
      setReport(categoryRemovalReport(outcomes));
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
    setMoving(null);
    setNotice(t("common", K.saved));
    await load();
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 sm:p-6">
      {surface.chrome}
      <PageHeader
        icon={Package}
        title={t("common", K.title)}
        subtitle={t("common", K.subtitle)}
        actions={
          <>
            <div className="flex flex-wrap items-center gap-2">
              {!guide && (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => {
                    setGuide(true);
                    writeGuideClosed(false);
                  }}
                  icon={<BookOpen size={14} aria-hidden />}
                >
                  {t("common", K.guide.show)}
                </Button>
              )}
              <Link href={surface.translationsHref} className={buttonClass({ variant: "quiet", size: "sm" })}>
                <Languages size={14} aria-hidden />
                {t("common", K.translations.open)}
                {pending ? (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] text-on-accent" title={t("common", K.translationsPending, { count: pending })}>
                    {pending}
                  </span>
                ) : null}
              </Link>
              <Button variant="primary" size="sm" onClick={() => setCreating("product")} icon={<Plus size={14} aria-hidden />}>
                {t("common", K.newProduct)}
              </Button>
            </div>
          </>
        }
      />

      {guide && <CatalogGuide onClose={closeGuide} />}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs<"products" | "categories" | "capabilities">
          ariaLabel={t("common", K.title)}
          variant="pills"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "products", label: t("common", K.tabs.products), badge: products ? String(products.length) : undefined },
            { value: "categories", label: t("common", K.tabs.categories), badge: String(categories.length) },
            { value: "capabilities", label: t("common", K.tabs.capabilities), badge: String(capabilities.length) },
          ]}
        />
        {tab === "products" ? (
          <div className="flex flex-wrap gap-2">
            <Select
              ariaLabel={t("common", K.filters.category)}
              value={categoryId}
              onChange={setCategoryId}
              options={[{ value: "", label: t("common", K.filters.allCategories) }, ...tree.map(({ category: c }) => ({ value: c.id, label: categoryName(c.id) }))]}
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
              <Button
                variant="quiet"
                size="sm"
                aria-pressed={showArchived}
                onClick={() => {
                  setShowArchived(!showArchived);
                  setSelected(new Set());
                }}
                icon={<Archive size={14} aria-hidden />}
              >
                {showArchived ? t("common", K.removal.showActive) : t("common", K.removal.showArchived, { count: archived.length })}
              </Button>
            )}
          </div>
        ) : tab === "capabilities" ? (
          <Button variant="quiet" size="sm" onClick={() => setCreating("capability")} icon={<Plus size={14} aria-hidden />}>
            {t("common", K.capabilities.new)}
          </Button>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(archivedCategories.length > 0 || showArchivedCategories) && (
              <Button
                variant="quiet"
                size="sm"
                aria-pressed={showArchivedCategories}
                onClick={() => {
                  setShowArchivedCategories(!showArchivedCategories);
                  setPickedCategories(new Set());
                }}
                icon={<Archive size={14} aria-hidden />}
              >
                {showArchivedCategories
                  ? t("common", K.categories.showActive)
                  : t("common", K.categories.showArchived, { count: archivedCategories.length })}
              </Button>
            )}
            <Button variant="quiet" size="sm" onClick={() => setCreating("category")} icon={<Tags size={14} aria-hidden />}>
              {t("common", K.newCategory)}
            </Button>
          </div>
        )}
      </div>

      {notice && (
        <p className="flex flex-wrap items-center gap-2 text-xs font-bold text-primary" role="status">
          {notice}
          {freshId && products?.some((p) => p.id === freshId) && (
            <Button variant="quiet" size="sm" onClick={() => setOpenId(freshId)}>
              {t("common", K.wizard.openNew)}
            </Button>
          )}
        </p>
      )}
      {report.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs font-bold text-primary" role="status">
          {report.map((line) => (
            <li key={line.key}>{t("common", line.key, { count: line.count })}</li>
          ))}
        </ul>
      )}
      {actionError && <Alert tone="error">{actionError}</Alert>}

      {sessionLoading || (!products && !error) ? (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t("common", K.loading)}
        </p>
      ) : error ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Alert tone="error">{message(error)}</Alert>
          <Button variant="quiet" size="sm" onClick={() => void load()} icon={<RotateCw size={14} aria-hidden />}>
            {t("common", K.retry)}
          </Button>
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
                      {categoryNames(p.categoryIds)} · {t("common", K.removal.archivedBadge)}
                      {p.tenantId === null && ` · ${t("common", K.platform)}`}
                    </p>
                  </div>
                  <Button variant="quiet" size="sm" onClick={() => void act(() => api.updateProduct(p.id, { archived: false }))} icon={<RotateCcw size={14} aria-hidden />}>
                    {t("common", K.removal.restore)}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : tab === "products" ? (
        shown.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-text-secondary">{t("common", K.empty)}</p>
            <Button variant="primary" size="sm" onClick={() => setCreating("product")} icon={<Plus size={14} aria-hidden />}>
              {t("common", K.newProduct)}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3 px-1 text-xs">
              <Checkbox
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(shown.map((p) => p.id)))}
                label={<span className="text-xs font-bold">{t("common", K.removal.selectAll)}</span>}
              />
              {selected.size > 0 && (
                <>
                  <span className="text-text-secondary">{t("common", K.removal.selected, { count: selected.size })}</span>
                  <Button
                    size="sm"
                    disabled={removing}
                    onClick={() => void removeSelected()}
                    icon={removing ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
                    className="text-error hover:text-error hover:bg-error-bg"
                  >
                    {t("common", removing ? K.removal.removing : K.removal.remove)}
                  </Button>
                </>
              )}
            </div>
            <ul className="flex flex-col gap-2">
              {shown.map((p) => (
                <li
                  key={p.id}
                  className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-card-bg p-3 shadow-sm ${p.id === freshId ? "border-primary ring-2 ring-primary/30" : "border-card-border"}`}
                >
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={nameOf(p)} />
                  <button type="button" className="min-w-0 flex-1 text-start" onClick={() => setOpenId(p.id)}>
                  <p className="truncate text-sm font-bold text-text-primary">{nameOf(p)}</p>
                  <p className="text-[11px] text-text-secondary">
                    {categoryNames(p.categoryIds)} · {t("common", K.fulfilmentKind[p.fulfilmentKind])}
                    {p.tenantId === null && ` · ${t("common", K.platform)}`}
                    {!p.isActive && ` · ${t("common", K.inactive)}`}
                  </p>
                  {p.featureKeys.length > 0 && (
                    <p className="mt-1 flex flex-wrap gap-1">
                      {p.featureKeys.map((k) => (
                        <span key={k} title={k} className="rounded-full bg-[var(--leaf-bg)] px-2 py-0.5 text-[10px] font-bold text-primary">
                          {capabilityName(k)}
                        </span>
                      ))}
                    </p>
                  )}
                </button>
                <div className="flex gap-1">
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => setRenaming({ kind: "product", id: p.id, nameKey: p.nameKey, descriptionKey: p.descriptionKey, sourceLang: p.sourceLang })}
                    icon={<Pencil size={14} aria-hidden />}
                  >
                    {t("common", K.rename)}
                  </Button>
                  <Button variant="quiet" size="sm" onClick={() => void act(() => api.updateProduct(p.id, { isActive: !p.isActive }))} icon={<Power size={14} aria-hidden />}>
                    {t("common", p.isActive ? K.deactivate : K.activate)}
                  </Button>
                  <Button variant="quiet" size="sm" onClick={() => setOpenId(p.id)}>
                    {t("common", K.open)}
                    <ChevronLeft size={14} className="ltr:-scale-x-100" aria-hidden />
                  </Button>
                </div>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : tab === "capabilities" ? (
        <CapabilitiesTab
          capabilities={capabilities}
          owner={owner}
          label={nameOf}
          onRename={(c) => setRenaming({ kind: "capability", id: c.id, nameKey: c.nameKey, descriptionKey: c.descriptionKey, sourceLang: c.sourceLang })}
          onRemove={(c) => void act(() => api.removeCapability(c.id))}
        />
      ) : showArchivedCategories ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-secondary">{t("common", K.categories.archivedHint)}</p>
          {archivedCategories.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-secondary">{t("common", K.categories.archivedEmpty)}</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {archivedCategories.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-card-border bg-card-bg p-3 opacity-80 shadow-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-text-primary">{nameOf(c)}</p>
                    <p className="text-[11px] text-text-secondary">
                      {t("common", K.categories.archivedProducts, { count: counts.get(c.id) ?? 0 })} · {t("common", K.removal.archivedBadge)}
                      {c.tenantId === null && ` · ${t("common", K.platform)}`}
                    </p>
                  </div>
                  <Button variant="quiet" size="sm" onClick={() => void act(() => api.updateCategory(c.id, RESTORE_CATEGORY))} icon={<RotateCcw size={14} aria-hidden />}>
                    {t("common", K.removal.restore)}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : categories.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-8">
          <p className="text-sm text-text-secondary">{t("common", K.categories.empty)}</p>
          <Button variant="primary" size="sm" onClick={() => setCreating("category")} icon={<Tags size={14} aria-hidden />}>
            {t("common", K.newCategory)}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3 px-1 text-xs">
            <Checkbox
              checked={allCategoriesPicked}
              onChange={() => setPickedCategories(allCategoriesPicked ? new Set() : new Set(categories.map((c) => c.id)))}
              label={<span className="text-xs font-bold">{t("common", K.removal.selectAll)}</span>}
            />
            {pickedCategories.size > 0 && (
              <>
                <span className="text-text-secondary">{t("common", K.categories.selected, { count: pickedCategories.size })}</span>
                <Button variant="quiet" size="sm" disabled={switching || removing} onClick={() => void switchCategories(true)} icon={<Power size={14} aria-hidden />}>
                  {t("common", K.categories.switchOn)}
                </Button>
                <Button variant="quiet" size="sm" disabled={switching || removing} onClick={() => void switchCategories(false)} icon={<Power size={14} aria-hidden />}>
                  {t("common", K.categories.switchOff)}
                </Button>
                <Button
                  size="sm"
                  disabled={switching || removing}
                  onClick={() => void removeCategories()}
                  icon={removing ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
                  className="text-error hover:text-error hover:bg-error-bg"
                >
                  {t("common", removing ? K.removal.removing : K.removal.remove)}
                </Button>
              </>
            )}
          </div>
          <ul className="flex flex-col gap-2">
            {tree.map(({ category: c, depth }) => (
              <li
                key={c.id}
                style={{ marginInlineStart: `${depth * 1.5}rem` }}
                className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-card-border bg-card-bg p-3 shadow-sm"
              >
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
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => setRenaming({ kind: "category", id: c.id, nameKey: c.nameKey, descriptionKey: null, sourceLang: c.sourceLang })}
                    icon={<Pencil size={14} aria-hidden />}
                  >
                    {t("common", K.rename)}
                  </Button>
                  <Button variant="quiet" size="sm" onClick={() => setMoving(c)} icon={<FolderTree size={14} aria-hidden />}>
                    {t("common", K.categories.move)}
                  </Button>
                  <Button variant="quiet" size="sm" onClick={() => void act(() => api.updateCategory(c.id, { isActive: !c.isActive }))} icon={<Power size={14} aria-hidden />}>
                    {t("common", c.isActive ? K.deactivate : K.activate)}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {creating === "category" && (
        <CategorySheet
          owner={owner}
          takenKeys={categories.map((c) => c.key)}
          categories={categories}
          label={nameOf}
          onClose={() => setCreating(null)}
          onSaved={saved}
        />
      )}
      {creating === "capability" && (
        <CapabilitySheet owner={owner} takenKeys={capabilities.map((c) => c.key)} onClose={() => setCreating(null)} onSaved={saved} />
      )}
      {creating === "product" && (
        <ProductWizard
          categories={categories}
          categoryLabel={nameOf}
          takenProductKeys={[...(products ?? []), ...archived].map((p) => p.key)}
          takenCategoryKeys={categories.map((c) => c.key)}
          capabilities={capabilities}
          capabilityLabel={nameOf}
          onCapabilityCreated={load}
          onClose={() => setCreating(null)}
          onCreated={async (productId, variantFailed) => {
            const next = afterWizard(productId, variantFailed);
            setCreating(null);
            setTab("products");
            setCategoryId("");
            setPlatformOnly(false);
            setShowArchived(false);
            await load();
            setFreshId(next.freshId);
            setOpenId(next.openId);
            setNotice(next.notice && t("common", next.notice));
            setActionError(next.error && t("common", next.error));
          }}
        />
      )}
      {openProduct && (
        <ProductDetailSheet
          product={openProduct}
          name={nameOf(openProduct)}
          capabilities={capabilities}
          capabilityLabel={nameOf}
          onCapabilityCreated={load}
          categories={categories}
          categoryLabel={nameOf}
          onClose={() => setOpenId(null)}
          onChanged={load}
        />
      )}
      {moving && <MoveCategorySheet category={moving} categories={categories} label={nameOf} onClose={() => setMoving(null)} onSaved={saved} />}
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
