"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Archive, BookOpen, Languages, Loader2, Package, Plus, RotateCw, Tags } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useCatalogSurface } from "../_lib/surface";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Select } from "../../_components/kit/Select";
import { CATALOG_KEYS as K, afterWizard, catalogText, categoryPath, categoryTree, categoryRemovalReport, heldByProducts, mergeRemovals, productCounts, removalReport, surfaceActor, switchReport, switchTargets } from "../_lib/catalog-form";
import { useCatalogData, type CatalogData } from "../_hooks/useCatalogData";
import { useIdSelection } from "../_hooks/useIdSelection";
import { CapabilitiesTab } from "./CapabilitiesTab";
import { CatalogGuide } from "./CatalogGuide";
import { CatalogSheets, type CatalogSheet } from "./CatalogSheets";
import { CategoryList } from "./CategoryList";
import { ProductList } from "./ProductList";
import { useMessage } from "./catalog-ui";
import { PageHeader } from "../../_components/kit/PageHeader";
import { Alert, Button, buttonClass, Tabs, useConfirm } from "../../_components/kit";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { formatList } from "../../_lib/digits";
import { isPlatformTenant } from "@/lib/tenant-type";

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
// Storage is read once per render and never announces a change, so there is nothing to subscribe to.
const noSubscription = () => () => {};

type Tab = "products" | "categories" | "capabilities";
type Feedback = { notice: string | null; error: string | null; report: { key: string; count: number }[] };
const NO_FEEDBACK: Feedback = { notice: null, error: null, report: [] };
const NO_FILTERS = { categoryId: "", platformOnly: false, showArchived: false };
const NO_DATA: CatalogData = { categories: [], archivedCategories: [], capabilities: [], products: [], archived: [], texts: {} };

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
 * The lists live in `useCatalogData`, the sheets in `CatalogSheets` (FE-1-i-a).
 */
export function CatalogView() {
  const { t, lang, availableLocales } = useLocale();
  const confirm = useConfirm();
  const message = useMessage();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const surface = useCatalogSurface();
  const { api } = surface;
  // Nobody is an owner on a reseller's screen: billing runs the work as the
  // reseller and refuses a platform item there, whoever is signed in (F-066-w8).
  const owner = isPlatformTenant(surfaceActor(me, surface.tenantId)?.tenant?.type);
  const langs = availableLocales.length ? availableLocales.map((l) => l.code) : [lang];
  const { data, error, pending, reload } = useCatalogData(api, langs);
  const { categories, archivedCategories, capabilities, products, archived, texts } = data ?? NO_DATA;
  const [tab, setTab] = useState<Tab>("products");
  const [filters, setFilters] = useState(NO_FILTERS);
  const [showArchivedCategories, setShowArchivedCategories] = useState(false);
  const productPicks = useIdSelection(products);
  // The categories tab has its own selection (F-026-k): a tab switch never carries one into the other.
  const categoryPicks = useIdSelection(categories);
  const [busy, setBusy] = useState<"removing" | "switching" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(NO_FEEDBACK);
  const [sheet, setSheet] = useState<CatalogSheet | null>(null);
  // The product the wizard just made (F-114-g): marked in the list, offered from the notice.
  const [freshId, setFreshId] = useState<string | null>(null);
  const guideClosed = useSyncExternalStore(noSubscription, readGuideClosed, () => true);
  const [guideChoice, setGuideChoice] = useState<boolean | null>(null);
  const guide = guideChoice ?? !guideClosed;
  const showGuide = (open: boolean) => {
    setGuideChoice(open);
    writeGuideClosed(!open);
  };

  // A change the host may care about (the setup wizard's checklist, UX-2-d).
  const changed = async () => {
    await reload();
    surface.onChanged?.();
  };

  const act = async (run: () => Promise<unknown>) => {
    setFeedback(NO_FEEDBACK);
    try {
      await run();
      setFeedback({ ...NO_FEEDBACK, notice: t("common", K.saved) });
      await changed();
    } catch (e) {
      setFeedback({ ...NO_FEEDBACK, error: message(e) });
    }
  };
  // A group action: busy while it runs, its outcome as a report, any failure as the page's error.
  const runGroup = async (kind: "removing" | "switching", run: () => Promise<Feedback["report"]>) => {
    setBusy(kind);
    setFeedback(NO_FEEDBACK);
    try {
      setFeedback({ ...NO_FEEDBACK, report: await run() });
      await changed();
    } catch (e) {
      setFeedback({ ...NO_FEEDBACK, error: message(e) });
    } finally {
      setBusy(null);
    }
  };

  const nameOf = (item: { key: string; nameKey: string; sourceLang: string }) => catalogText(texts, lang, item.nameKey, item.sourceLang) ?? item.key;
  // A product sits in several categories (F-026-r): each named by its path from the top, first first.
  const categoryName = (id: string) => {
    const all = [...categories, ...archivedCategories];
    return all.some((x) => x.id === id) ? categoryPath(all, id, nameOf) : "—";
  };
  const categoryNames = (ids: readonly string[]) => formatList(ids.map(categoryName), lang);
  const tree = useMemo(() => categoryTree(categories), [categories]);
  const capabilityName = (k: string) => {
    const c = capabilities.find((x) => x.key === k);
    return c ? nameOf(c) : k;
  };
  const listed = filters.showArchived ? archived : products;
  const shown = listed.filter((p) => (!filters.categoryId || p.categoryIds.includes(filters.categoryId)) && (!filters.platformOnly || p.platform));
  // Archived products count: billing keeps a category any of them sits in (F-026-j).
  const counts = useMemo(() => productCounts(products, archived), [products, archived]);

  const removeSelected = async () => {
    const ids = [...productPicks.selected];
    if (ids.length === 0 || !(await confirm({ title: t("common", K.removal.confirm, { count: ids.length }), confirmLabel: t("common", FrontendI18nKeys.common.kit.confirm.delete), tone: "danger" }))) return;
    await runGroup("removing", async () => {
      const report = removalReport(await api.removeProducts(ids));
      productPicks.clear();
      return report;
    });
  };
  const removeCategories = async () => {
    const ids = [...categoryPicks.selected];
    if (ids.length === 0 || !(await confirm({ title: t("common", K.categories.confirm, { count: ids.length }), confirmLabel: t("common", FrontendI18nKeys.common.kit.confirm.delete), tone: "danger" }))) return;
    await runGroup("removing", async () => {
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
      categoryPicks.clear();
      return categoryRemovalReport(outcomes);
    });
  };
  // One PATCH per category that changes, each on its own; the list is read once after all of them.
  const switchCategories = (on: boolean) =>
    runGroup("switching", async () =>
      switchReport(await Promise.allSettled(switchTargets(categoryPicks.selected, categories, on).map((id) => api.updateCategory(id, { isActive: on })))),
    );

  const saved = async () => {
    setSheet(null);
    setFeedback({ ...NO_FEEDBACK, notice: t("common", K.saved) });
    await changed();
  };
  const productCreated = async (productId: string, variantFailed: boolean) => {
    const next = afterWizard(productId, variantFailed);
    setSheet(null);
    setTab("products");
    setFilters(NO_FILTERS);
    await changed();
    setFreshId(next.freshId);
    if (next.openId) setSheet({ kind: "open", productId: next.openId });
    setFeedback({ ...NO_FEEDBACK, notice: next.notice && t("common", next.notice), error: next.error && t("common", next.error) });
  };

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {!guide && (
        <Button variant="quiet" size="sm" onClick={() => showGuide(true)} icon={<BookOpen size={14} aria-hidden />}>
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
      <Button variant="primary" size="sm" onClick={() => setSheet({ kind: "create", what: "product" })} icon={<Plus size={14} aria-hidden />}>
        {t("common", K.newProduct)}
      </Button>
    </div>
  );

  return (
    <div className={surface.embedded ? "flex flex-col gap-5" : "mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 sm:p-6"}>
      {surface.embedded ? (
        <div className="flex justify-end">{actions}</div>
      ) : (
        <PageHeader icon={Package} title={t("common", K.title)} subtitle={t("common", K.subtitle)} actions={actions} />
      )}
      {surface.chrome}

      {guide && <CatalogGuide onClose={() => showGuide(false)} />}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs<Tab>
          ariaLabel={t("common", K.title)}
          variant="pills"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "products", label: t("common", K.tabs.products), badge: data ? String(products.length) : undefined },
            { value: "categories", label: t("common", K.tabs.categories), badge: String(categories.length) },
            { value: "capabilities", label: t("common", K.tabs.capabilities), badge: String(capabilities.length) },
          ]}
        />
        {tab === "products" ? (
          <div className="flex flex-wrap gap-2">
            <Select
              ariaLabel={t("common", K.filters.category)}
              value={filters.categoryId}
              onChange={(categoryId) => setFilters({ ...filters, categoryId })}
              options={[{ value: "", label: t("common", K.filters.allCategories) }, ...tree.map(({ category: c }) => ({ value: c.id, label: categoryName(c.id) }))]}
              className="w-44"
            />
            {owner && (
              <Select
                ariaLabel={t("common", K.filters.scope)}
                value={filters.platformOnly ? "platform" : ""}
                onChange={(v) => setFilters({ ...filters, platformOnly: v === "platform" })}
                options={[
                  { value: "", label: t("common", K.filters.scopeAll) },
                  { value: "platform", label: t("common", K.filters.scopePlatform) },
                ]}
                className="w-40"
              />
            )}
            {(archived.length > 0 || filters.showArchived) && (
              <Button
                variant="quiet"
                size="sm"
                aria-pressed={filters.showArchived}
                onClick={() => {
                  setFilters({ ...filters, showArchived: !filters.showArchived });
                  productPicks.clear();
                }}
                icon={<Archive size={14} aria-hidden />}
              >
                {filters.showArchived ? t("common", K.removal.showActive) : t("common", K.removal.showArchived, { count: archived.length })}
              </Button>
            )}
          </div>
        ) : tab === "capabilities" ? (
          <Button variant="quiet" size="sm" onClick={() => setSheet({ kind: "create", what: "capability" })} icon={<Plus size={14} aria-hidden />}>
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
                  categoryPicks.clear();
                }}
                icon={<Archive size={14} aria-hidden />}
              >
                {showArchivedCategories
                  ? t("common", K.categories.showActive)
                  : t("common", K.categories.showArchived, { count: archivedCategories.length })}
              </Button>
            )}
            <Button variant="quiet" size="sm" onClick={() => setSheet({ kind: "create", what: "category" })} icon={<Tags size={14} aria-hidden />}>
              {t("common", K.newCategory)}
            </Button>
          </div>
        )}
      </div>

      {feedback.notice && (
        <p className="flex flex-wrap items-center gap-2 text-xs font-bold text-primary" role="status">
          {feedback.notice}
          {freshId && products.some((p) => p.id === freshId) && (
            <Button variant="quiet" size="sm" onClick={() => setSheet({ kind: "open", productId: freshId })}>
              {t("common", K.wizard.openNew)}
            </Button>
          )}
        </p>
      )}
      {feedback.report.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs font-bold text-primary" role="status">
          {feedback.report.map((line) => (
            <li key={line.key}>{t("common", line.key, { count: line.count })}</li>
          ))}
        </ul>
      )}
      {feedback.error && <Alert tone="error">{feedback.error}</Alert>}

      {sessionLoading || (!data && !error) ? (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t("common", K.loading)}
        </p>
      ) : error ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Alert tone="error">{message(error)}</Alert>
          <Button variant="quiet" size="sm" onClick={() => void reload()} icon={<RotateCw size={14} aria-hidden />}>
            {t("common", K.retry)}
          </Button>
        </div>
      ) : tab === "products" ? (
        <ProductList
          shown={shown}
          archived={filters.showArchived}
          selection={productPicks}
          removing={busy === "removing"}
          freshId={freshId}
          nameOf={nameOf}
          categoryNames={categoryNames}
          capabilityName={capabilityName}
          onSheet={setSheet}
          onAct={(run) => void act(run)}
          onRemove={() => void removeSelected()}
          api={api}
        />
      ) : tab === "capabilities" ? (
        <CapabilitiesTab
          capabilities={capabilities}
          owner={owner}
          label={nameOf}
          onRename={(c) => setSheet({ kind: "rename", item: { kind: "capability", id: c.id, nameKey: c.nameKey, descriptionKey: c.descriptionKey, sourceLang: c.sourceLang } })}
          onRemove={(c) => void act(() => api.removeCapability(c.id))}
        />
      ) : (
        <CategoryList
          categories={categories}
          tree={tree}
          archivedCategories={archivedCategories}
          showArchived={showArchivedCategories}
          counts={counts}
          selection={categoryPicks}
          busy={busy}
          nameOf={nameOf}
          onSheet={setSheet}
          onAct={(run) => void act(run)}
          onSwitch={(on) => void switchCategories(on)}
          onRemove={() => void removeCategories()}
          onShowProducts={(categoryId) => {
            setFilters({ ...filters, categoryId });
            setTab("products");
          }}
          api={api}
        />
      )}

      {data && (
        <CatalogSheets
          sheet={sheet}
          data={data}
          nameOf={nameOf}
          reload={reload}
          onClose={() => setSheet(null)}
          onSaved={saved}
          onChanged={changed}
          onProductCreated={productCreated}
        />
      )}
    </div>
  );
}
