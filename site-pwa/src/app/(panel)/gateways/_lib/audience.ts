import type { Me } from "@/lib/auth-api";
import type { AdminGateway } from "@/lib/billing-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

/**
 * Who a gateway is offered to (F-102-g): `everyone`, or only `groups` — users
 * in at least one of the owner's chosen groups. The service takes the set
 * whole (`PUT …/audience`); `everyone` is the empty set.
 */
export type AudienceMode = "everyone" | "groups";

const A = FrontendI18nKeys.common.gateways.audience;

export const modeOf = (ids: readonly string[]): AudienceMode => (ids.length === 0 ? "everyone" : "groups");

/** What is sent: the empty set for everyone, the chosen groups otherwise. */
export const audienceBody = (mode: AudienceMode, selected: readonly string[]): string[] => (mode === "everyone" ? [] : [...selected]);

/** A limited gateway with no group would be offered to nobody: that is switching it off, which is its own control. */
export function audienceError(mode: AudienceMode, selected: readonly string[]): string | null {
  return mode === "groups" && selected.length === 0 ? A.pickOne : null;
}

export function audienceChanged(saved: readonly string[], mode: AudienceMode, selected: readonly string[]): boolean {
  const next = audienceBody(mode, selected);
  return next.length !== saved.length || next.some((id) => !saved.includes(id));
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
