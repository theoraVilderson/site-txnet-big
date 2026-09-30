"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { catalogApi, type CatalogAdminApi } from "@/lib/catalog-api";
import { PANEL_CATALOG, PANEL_CATALOG_TRANSLATIONS } from "@/lib/routes";
import { pricingCurrencyQuery } from "./catalog-form";

/**
 * Which tenant's catalog a catalog screen manages (F-066-w8).
 *
 * The ambient page (`/catalog`) is the caller's own tenant. A reseller's
 * workspace screen (`/my-resellers/:id/catalog`) names the reseller, and
 * billing then runs the work **as** that reseller (`catalog/contract.md`, "The
 * same management for a reseller a route names"). Everything the two screens
 * differ by is in this one object, so there is one catalog page and not two —
 * the list, the wizard, the sheets and the review are the same components
 * either way.
 *
 * Unlike the gateway screens' surface (`gateways/_lib/surface.ts`), this one
 * travels by context rather than by prop: the calls are made four components
 * deep (`VariantCard`, `NewVariant`, `Capabilities`), and a prop threaded
 * through all of them is a prop somebody forgets to pass — which is exactly
 * the failure this surface exists to prevent.
 */
export interface CatalogSurface {
  /** The reseller the path names; `null` on the ambient page. */
  tenantId: string | null;
  /** Its calls — `catalogAdminApi` for that tenant. */
  api: CatalogAdminApi;
  /** This surface's own two pages: the list, and where its drafted names are reviewed. */
  catalogHref: string;
  translationsHref: string;
  /** Put above the page's header: the way back to the console, and whose catalog this is. */
  chrome?: ReactNode;
  /** The sentence key for a refusal this surface knows (`ResellerAccess`'s); the generic answer otherwise. */
  refusalKey?: (e: unknown) => string | null;
}

/** The caller's own tenant, which is what the catalog page was before there was a second surface. */
export const AMBIENT_CATALOG: CatalogSurface = {
  tenantId: null,
  api: catalogApi,
  catalogHref: PANEL_CATALOG,
  translationsHref: PANEL_CATALOG_TRANSLATIONS,
};

const CatalogSurfaceContext = createContext<CatalogSurface>(AMBIENT_CATALOG);

export const CatalogSurfaceProvider = CatalogSurfaceContext.Provider;

/** The surface the screen around this component set; the ambient one where none did. */
export const useCatalogSurface = () => useContext(CatalogSurfaceContext);

/**
 * The code a price field names (F-116-h10): billing's answer for whose rows are
 * priced — `product.tenantId`, or the wizard's `wizardVariantTenant`. `null`
 * until it answers, or when it refuses; a label then names no currency.
 */
export function usePricingCurrency(
  owner: string | null | undefined,
): string | null {
  const { api } = useCatalogSurface();
  const query = pricingCurrencyQuery(owner);
  const [answer, setAnswer] = useState<{ query: string; code: string } | null>(
    null,
  );
  useEffect(() => {
    if (query === null) return;
    let live = true;
    api.pricingCurrency(query).then(
      ({ code }) => live && setAnswer({ query, code }),
      () => live && setAnswer(null),
    );
    return () => {
      live = false;
    };
    // The surface's api is fixed for the page; whose rows is what decides a load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  return answer && answer.query === query ? answer.code : null;
}

/** The code `usePricingCurrency` answered for the sheet or wizard around a field — the fields sit several components deep. */
export const PricingCurrencyContext = createContext<string | null>(null);
export const usePricedIn = () => useContext(PricingCurrencyContext);
