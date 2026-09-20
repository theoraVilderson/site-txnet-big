"use client";

import { createContext, useContext, type ReactNode } from "react";
import { catalogApi, type CatalogAdminApi } from "@/lib/catalog-api";
import { PANEL_CATALOG, PANEL_CATALOG_TRANSLATIONS } from "@/lib/routes";

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
