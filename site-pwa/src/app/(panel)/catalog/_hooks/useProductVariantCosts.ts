"use client";

import { useEffect, useMemo, useState } from "react";
import { catalogCostApi, type CostRow } from "@/lib/catalog-cost-api";
import { useCatalogSurface } from "../_lib/surface";

/** One variant's cost history as its card gets it: the rows, `null` while the sheet reads, `"failed"` when it could not. */
export type VariantCostHistory = CostRow[] | "failed" | null;

type ProductCosts = { productId: string; byVariant: Record<string, CostRow[]> | "failed" };

/**
 * Every variant's cost history of one product, read once when its sheet opens
 * (LIVE-1-d): one read per variant spent a 32-variant product's sheet out of
 * `CATALOG_ADMIN_READ`. A card re-reads its own history only after a write.
 */
export function useProductVariantCosts(productId: string): ProductCosts | null {
  const { tenantId } = useCatalogSurface();
  const api = useMemo(() => catalogCostApi(tenantId), [tenantId]);
  const [costs, setCosts] = useState<ProductCosts | null>(null);
  useEffect(() => {
    let live = true;
    api.productVariantCosts(productId).then(
      (byVariant) => live && setCosts({ productId, byVariant }),
      () => live && setCosts({ productId, byVariant: "failed" }),
    );
    return () => {
      live = false;
    };
  }, [api, productId]);
  return costs?.productId === productId ? costs : null;
}

/** A variant's share of the read; one the read never saw was added after it, and has no cost yet. */
export function historyOf(costs: ProductCosts | null, variantId: string): VariantCostHistory {
  if (costs === null) return null;
  if (costs.byVariant === "failed") return "failed";
  return costs.byVariant[variantId] ?? [];
}
