"use client";

import { useEffect, useState } from "react";
import { catalogApi, type CatalogProduct } from "@/lib/catalog-api";
import { resellerLimitsApi, type ResellerLimitRow } from "@/lib/tenant-api";
import { useCatalogTexts } from "../../../catalog/_lib/meter-names";
import { offeredProduct } from "../../_lib/package-wizard";

/** What the new-package wizard offers: the platform products a package may list, and every registry key at the platform's value. */
export interface PackageWizardInputs {
  products: CatalogProduct[];
  limits: ResellerLimitRow[];
}

/**
 * The wizard's two reads (PK-1-g): billing's products — the platform's own,
 * offered ones only — and `GET /tenants/limits/settings`. A product's name is
 * the catalog's published text, its key until there is one.
 */
export function usePackageWizardInputs() {
  const [inputs, setInputs] = useState<PackageWizardInputs | null>(null);
  const texts = useCatalogTexts();
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([catalogApi.products(), resellerLimitsApi.table()]).then(
      ([products, limits]) => {
        if (!alive) return;
        setInputs({ products: products.filter(offeredProduct), limits });
        setError(null);
      },
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [asked]);

  const productName = (p: Pick<CatalogProduct, "nameKey" | "key">) => texts[p.nameKey] || p.key;
  return { inputs, error, productName, retry: () => setAsked((n) => n + 1) };
}
