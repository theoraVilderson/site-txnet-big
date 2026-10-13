"use client";

import { ChevronLeft, Loader2, Pencil, Plus, Power, RotateCcw, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { CatalogAdminApi, CatalogProduct } from "@/lib/catalog-api";
import { CATALOG_KEYS as K } from "../_lib/catalog-form";
import type { IdSelection } from "../_hooks/useIdSelection";
import type { CatalogSheet } from "./CatalogSheets";
import { Button, Checkbox } from "../../_components/kit";

interface Props {
  /** The products the filters let through, archived ones when `archived`. */
  shown: readonly CatalogProduct[];
  archived: boolean;
  selection: IdSelection;
  removing: boolean;
  /** The product the wizard just made (F-114-g), marked in the list. */
  freshId: string | null;
  nameOf: (p: CatalogProduct) => string;
  categoryNames: (ids: readonly string[]) => string;
  capabilityName: (key: string) => string;
  onSheet: (sheet: CatalogSheet) => void;
  onAct: (run: () => Promise<unknown>) => void;
  onRemove: () => void;
  api: CatalogAdminApi;
}

/** The products tab's list (F-026-f): the active ones to tick and remove (F-026-i), or the archived to restore (F-026-h). */
export function ProductList(props: Props) {
  const { t } = useLocale();
  const { shown, nameOf, categoryNames, onAct, api } = props;

  if (props.archived) {
    return (
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
                  <p className="text-2xs text-text-secondary">
                    {categoryNames(p.categoryIds)} · {t("common", K.removal.archivedBadge)}
                    {p.platform && ` · ${t("common", K.platform)}`}
                  </p>
                </div>
                <Button variant="quiet" size="sm" onClick={() => onAct(() => api.updateProduct(p.id, { archived: false }))} icon={<RotateCcw size={14} aria-hidden />}>
                  {t("common", K.removal.restore)}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (shown.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <p className="text-sm text-text-secondary">{t("common", K.empty)}</p>
        <Button variant="primary" size="sm" onClick={() => props.onSheet({ kind: "create", what: "product" })} icon={<Plus size={14} aria-hidden />}>
          {t("common", K.newProduct)}
        </Button>
      </div>
    );
  }

  const { selected, toggle, pick, clear } = props.selection;
  const allSelected = shown.every((p) => selected.has(p.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 px-1 text-xs">
        <Checkbox
          checked={allSelected}
          onChange={() => (allSelected ? clear() : pick(shown.map((p) => p.id)))}
          label={<span className="text-xs font-bold">{t("common", K.removal.selectAll)}</span>}
        />
        {selected.size > 0 && (
          <>
            <span className="text-text-secondary">{t("common", K.removal.selected, { count: selected.size })}</span>
            <Button
              size="sm"
              disabled={props.removing}
              onClick={props.onRemove}
              icon={props.removing ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
              className="text-error hover:text-error hover:bg-error-bg"
            >
              {t("common", props.removing ? K.removal.removing : K.removal.remove)}
            </Button>
          </>
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {shown.map((p) => (
          <li
            key={p.id}
            className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-card-bg p-3 shadow-sm ${p.id === props.freshId ? "border-primary ring-2 ring-primary/30" : "border-card-border"}`}
          >
            <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={nameOf(p)} />
            <button type="button" className="min-w-0 flex-1 text-start" onClick={() => props.onSheet({ kind: "open", productId: p.id })}>
              <p className="truncate text-sm font-bold text-text-primary">{nameOf(p)}</p>
              <p className="text-2xs text-text-secondary">
                {categoryNames(p.categoryIds)} · {t("common", K.fulfilmentKind[p.fulfilmentKind])}
                {p.platform && ` · ${t("common", K.platform)}`}
                {!p.isActive && ` · ${t("common", K.inactive)}`}
                {(p.userGroupIds?.length ?? 0) > 0 && ` · ${t("common", K.audience.limited)}`}
              </p>
              {p.featureKeys.length > 0 && (
                <p className="mt-1 flex flex-wrap gap-1">
                  {p.featureKeys.map((k) => (
                    <span key={k} title={k} className="rounded-full bg-[var(--leaf-bg)] px-2 py-0.5 text-3xs font-bold text-primary">
                      {props.capabilityName(k)}
                    </span>
                  ))}
                </p>
              )}
            </button>
            <div className="flex gap-1">
              <Button
                variant="quiet"
                size="sm"
                onClick={() => props.onSheet({ kind: "rename", item: { kind: "product", id: p.id, nameKey: p.nameKey, descriptionKey: p.descriptionKey, sourceLang: p.sourceLang } })}
                icon={<Pencil size={14} aria-hidden />}
              >
                {t("common", K.rename)}
              </Button>
              <Button variant="quiet" size="sm" onClick={() => onAct(() => api.updateProduct(p.id, { isActive: !p.isActive }))} icon={<Power size={14} aria-hidden />}>
                {t("common", p.isActive ? K.deactivate : K.activate)}
              </Button>
              <Button variant="quiet" size="sm" onClick={() => props.onSheet({ kind: "open", productId: p.id })}>
                {t("common", K.open)}
                <ChevronLeft size={14} className="ltr:-scale-x-100" aria-hidden />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
