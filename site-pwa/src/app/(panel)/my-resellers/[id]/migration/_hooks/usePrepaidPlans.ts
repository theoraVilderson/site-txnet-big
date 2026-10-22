"use client";

import { useEffect, useState } from "react";
import { resellerGrantsApi } from "@/lib/billing-api";
import { useCatalogTexts } from "../../../../catalog/_lib/meter-names";
import { mappingOptions } from "../../../_lib/migration";

/**
 * The prepaid plans an import may issue (entitlement `contract.import.md`
 * rule 10), from the users-admin door's catalog — the one the issue form
 * reads — so no `catalog.manage` is needed. `plans` is null while it loads.
 */
export function usePrepaidPlans(tenantId: string): { plans: { value: string; label: string }[] | null; error: unknown } {
  const texts = useCatalogTexts();
  const [products, setProducts] = useState<Parameters<typeof mappingOptions>[0] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    resellerGrantsApi(tenantId)
      .usersCatalog()
      .then((list) => alive && setProducts(list))
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [tenantId]);

  return { plans: products ? mappingOptions(products, texts) : null, error };
}
