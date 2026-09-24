"use client";

import type { ReactNode } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ambientGatewayApi, type GatewayAdminApi } from "@/lib/billing-api";

/**
 * Which tenant's gateways a gateway screen configures (F-066-w4).
 *
 * The ambient page (`/gateways`) is the caller's own tenant. A reseller's
 * workspace screen (`/my-resellers/:id/gateways`) names the reseller, and
 * billing then runs the work **as** that reseller
 * (`billing/contract.gateways.md`, "A named reseller's gateways"). Everything
 * the two screens differ by is in this one object, so there is one gateway
 * page and not two — the list, the wizard and the editor are the same
 * components either way.
 */
export interface GatewaySurface {
  /** The reseller the path names; `null` on the ambient page. */
  tenantId: string | null;
  /** Its eight calls — `gatewayAdminApi` for that tenant. */
  api: GatewayAdminApi;
  /** Put above the page's header: the way back to the console, and whose gateways these are. */
  chrome?: ReactNode;
  /** The sentence key for a refusal this surface knows (`ResellerAccess`'s); the generic answer otherwise. */
  refusalKey?: (e: unknown) => string | null;
}

/** The caller's own tenant, which is what the gateway page was before there was a second surface. */
export const AMBIENT_GATEWAYS: GatewaySurface = { tenantId: null, api: ambientGatewayApi };

/**
 * One sentence for a failed call, the same on the list, the wizard and the
 * editor: the surface's own wording where it has one, the service's answer
 * otherwise. Read and write must not explain the same refusal two ways.
 */
export function useGatewayMessage(surface: GatewaySurface): (e: unknown) => string {
  const { t } = useLocale();
  const generic = useApiErrorMessage();
  return (e: unknown) => {
    const key = surface.refusalKey?.(e);
    return key ? t("common", key) : generic(e);
  };
}
