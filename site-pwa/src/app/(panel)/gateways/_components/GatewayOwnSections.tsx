"use client";

import type { Me } from "@/lib/auth-api";
import type { AdminGateway } from "@/lib/billing-api";
import { ownsAudience, type GatewaySurface } from "../_lib/surface";
import { GatewayAudienceSection } from "./GatewayAudienceSection";
import { GatewayCommissionSection } from "./GatewayCommissionSection";

/**
 * The editor's sections that belong to the gateway's owner and save on their
 * own routes, never part of "what changed": who sees it (F-102-g-e) and what
 * its provider deducts (F-1001-w). Neither is offered on another tenant's
 * gateway from the platform's list (`ownsAudience`).
 */
export function GatewayOwnSections({ gateway, surface, me, onAudienceSaved }: { gateway: AdminGateway; surface: GatewaySurface; me: Pick<Me, "tenant"> | null; onAudienceSaved?: () => void }) {
  if (!ownsAudience(gateway, surface.tenantId, me)) return null;
  return (
    <>
      <GatewayAudienceSection gateway={gateway} surface={surface} onSaved={() => onAudienceSaved?.()} />
      <GatewayCommissionSection gateway={gateway} surface={surface} />
    </>
  );
}
