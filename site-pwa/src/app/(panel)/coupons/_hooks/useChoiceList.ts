"use client";

import { useEffect, useState } from "react";
import { catalogApi, type CatalogProductDetail } from "@/lib/catalog-api";
import type { Choice } from "../_components/ChoicePicker";

/** A list read once for a picker: `null` while it loads, `"failed"` when the caller may not read it. */
export type ChoiceList<T> = T | null | "failed";

/**
 * Read a picker's list once. The lists come from routes with their own
 * permissions (`catalog.manage`, `/tenants`) that a coupon manager may not
 * hold, so a refused read is `"failed"` and the picker falls back to typing
 * the id. `read` must be a module-level function: it is the effect's key.
 */
export function useChoiceList<T>(read: () => Promise<T>): ChoiceList<T> {
  const [list, setList] = useState<ChoiceList<T>>(null);
  useEffect(() => {
    let live = true;
    read().then(
      (v) => live && setList(v),
      () => live && setList("failed"),
    );
    return () => {
      live = false;
    };
  }, [read]);
  return list;
}

/** Live, unarchived products by key — a discount rule's target, a coupon's service scope. */
export const readProductChoices = async (): Promise<Choice[]> =>
  (await catalogApi.products()).filter((p) => p.isActive && !p.archivedAt).map((p) => ({ value: p.id, label: p.key }));

/** Live, unarchived categories by key — a discount rule's target. */
export const readCategoryChoices = async (): Promise<Choice[]> =>
  (await catalogApi.categories()).filter((c) => c.isActive && !c.archivedAt).map((c) => ({ value: c.id, label: c.key }));

/** Every product with its variants, for the variant pickers (`variantChoices`). */
export const readCatalogDetails = async (): Promise<CatalogProductDetail[]> =>
  Promise.all((await catalogApi.products()).map((p) => catalogApi.product(p.id)));
