"use client";

import type { ReactNode } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { Me } from "@/lib/auth-api";
import { ambientGatewayApi, type AdminGateway, type GatewayAdminApi } from "@/lib/billing-api";

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
  /** Put under the page's header: whose gateways these are, and the workspace's tab bar (contract.ux.md N8). */
  chrome?: ReactNode;
  /** The sentence key for a refusal this surface knows (`ResellerAccess`'s); the generic answer otherwise. */
  refusalKey?: (e: unknown) => string | null;
  /** Inside another page — the setup wizard's step (UX-2-d): no page frame or title, the actions kept. */
  embedded?: boolean;
  /** After a gateway is created, edited or removed and the list re-read: the wizard re-reads its checklist. */
  onChanged?: () => void;
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

/**
 * Whether this screen may set the gateway's audience: it is the surface's own
 * tenant's. The platform owner's `/gateways` lists every reseller's gateways
 * too, but its groups are the platform's — a reseller's gateway is given its
 * audience from that reseller's workspace, with that reseller's groups.
 */
export function ownsAudience(gateway: Pick<AdminGateway, "source" | "tenantId">, surfaceTenantId: string | null, me: Pick<Me, "tenant"> | null): boolean {
  if (surfaceTenantId !== null) return gateway.tenantId === surfaceTenantId;
  return gateway.source === "platform" || gateway.tenantId === me?.tenant.id;
}
