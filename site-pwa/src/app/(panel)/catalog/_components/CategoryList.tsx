"use client";

import { FolderTree, Loader2, Pencil, Power, RotateCcw, Tags, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { CatalogAdminApi, CatalogCategory } from "@/lib/catalog-api";
import { CATALOG_KEYS as K, RESTORE_CATEGORY } from "../_lib/catalog-form";
import type { IdSelection } from "../_hooks/useIdSelection";
import type { CatalogSheet } from "./CatalogSheets";
import { Button, Checkbox } from "../../_components/kit";

interface Props {
  categories: readonly CatalogCategory[];
  /** The categories in tree order, each with its depth under the top. */
  tree: readonly { category: CatalogCategory; depth: number }[];
  /** Categories archived with their sold products (F-026-l), listed instead of the tree when `showArchived`. */
  archivedCategories: readonly CatalogCategory[];
  showArchived: boolean;
  /** Products per category, archived ones included (F-026-j). */
  counts: ReadonlyMap<string, number>;
  selection: IdSelection;
  busy: "removing" | "switching" | null;
  nameOf: (c: CatalogCategory) => string;
  onSheet: (sheet: CatalogSheet) => void;
  onAct: (run: () => Promise<unknown>) => void;
  onSwitch: (on: boolean) => void;
  onRemove: () => void;
  /** A category's own row opens the products tab filtered to it. */
  onShowProducts: (categoryId: string) => void;
  api: CatalogAdminApi;
}

/** The categories tab (F-026-k): the tree to tick, switch and remove, or the archived to restore (F-026-l). */
export function CategoryList(props: Props) {
  const { t } = useLocale();
  const { categories, counts, nameOf, onAct, api } = props;

  if (props.showArchived) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-text-secondary">{t("common", K.categories.archivedHint)}</p>
        {props.archivedCategories.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-secondary">{t("common", K.categories.archivedEmpty)}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {props.archivedCategories.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-card-border bg-card-bg p-3 opacity-80 shadow-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-text-primary">{nameOf(c)}</p>
                  <p className="text-2xs text-text-secondary">
                    {t("common", K.categories.archivedProducts, { count: counts.get(c.id) ?? 0 })} · {t("common", K.removal.archivedBadge)}
                    {c.platform && ` · ${t("common", K.platform)}`}
                  </p>
                </div>
                <Button variant="quiet" size="sm" onClick={() => onAct(() => api.updateCategory(c.id, RESTORE_CATEGORY))} icon={<RotateCcw size={14} aria-hidden />}>
                  {t("common", K.removal.restore)}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (categories.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <p className="text-sm text-text-secondary">{t("common", K.categories.empty)}</p>
        <Button variant="primary" size="sm" onClick={() => props.onSheet({ kind: "create", what: "category" })} icon={<Tags size={14} aria-hidden />}>
          {t("common", K.newCategory)}
        </Button>
      </div>
    );
  }

  const { selected, toggle, pick, clear } = props.selection;
  const allPicked = categories.every((c) => selected.has(c.id));
  const busy = props.busy !== null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 px-1 text-xs">
        <Checkbox
          checked={allPicked}
          onChange={() => (allPicked ? clear() : pick(categories.map((c) => c.id)))}
          label={<span className="text-xs font-bold">{t("common", K.removal.selectAll)}</span>}
        />
        {selected.size > 0 && (
          <>
            <span className="text-text-secondary">{t("common", K.categories.selected, { count: selected.size })}</span>
            <Button variant="quiet" size="sm" disabled={busy} onClick={() => props.onSwitch(true)} icon={<Power size={14} aria-hidden />}>
              {t("common", K.categories.switchOn)}
            </Button>
            <Button variant="quiet" size="sm" disabled={busy} onClick={() => props.onSwitch(false)} icon={<Power size={14} aria-hidden />}>
              {t("common", K.categories.switchOff)}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={props.onRemove}
              icon={props.busy === "removing" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
              className="text-error hover:text-error hover:bg-error-bg"
            >
              {t("common", props.busy === "removing" ? K.removal.removing : K.removal.remove)}
            </Button>
          </>
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {props.tree.map(({ category: c, depth }) => (
          <li
            key={c.id}
            style={{ marginInlineStart: `${depth * 1.5}rem` }}
            className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-card-border bg-card-bg p-3 shadow-sm"
          >
            <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={nameOf(c)} />
            <button type="button" className="min-w-0 flex-1 text-start" onClick={() => props.onShowProducts(c.id)}>
              <p className="truncate text-sm font-bold text-text-primary">{nameOf(c)}</p>
              <p className="text-2xs text-text-secondary">
                {t("common", K.categories.products, { count: counts.get(c.id) ?? 0 })}
                {c.platform && ` · ${t("common", K.platform)}`}
                {!c.isActive && ` · ${t("common", K.inactive)}`}
              </p>
            </button>
            <div className="flex gap-1">
              <Button
                variant="quiet"
                size="sm"
                onClick={() => props.onSheet({ kind: "rename", item: { kind: "category", id: c.id, nameKey: c.nameKey, descriptionKey: null, sourceLang: c.sourceLang } })}
                icon={<Pencil size={14} aria-hidden />}
              >
                {t("common", K.rename)}
              </Button>
              <Button variant="quiet" size="sm" onClick={() => props.onSheet({ kind: "move", category: c })} icon={<FolderTree size={14} aria-hidden />}>
                {t("common", K.categories.move)}
              </Button>
              <Button variant="quiet" size="sm" onClick={() => onAct(() => api.updateCategory(c.id, { isActive: !c.isActive }))} icon={<Power size={14} aria-hidden />}>
                {t("common", c.isActive ? K.deactivate : K.activate)}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
