import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The screen's own strings as generated constants (C-06); the list itself keeps `common.gateways`. */
export const RESELLER_GATEWAY_KEYS = FrontendI18nKeys.common.resellerGateways;
const K = RESELLER_GATEWAY_KEYS;

/**
 * Every reason `/api/billing/tenants/:tenantId/gateways` refuses with — both
 * doors: shared-core's `ResellerAccessRejection` (who may configure this
 * reseller, invariant 21) and billing's `GatewayAdminRejection` (what may be
 * done to a gateway). The spec reads the union from the controller's own
 * exhaustive status map, so a reason added there has no sentence here until it
 * is written.
 */
export type ResellerGatewayRefusal =
  | "not_allowed"
  | "reseller_not_found"
  | "reseller_suspended"
  | "reseller_terminated"
  | "not_platform_owner"
  | "verification_is_platform_owners"
  | "gateway_not_found"
  | "tenant_not_found"
  | "provider_already_configured"
  | "gateway_has_open_payments"
  | "invalid_range"
  | "missing_field"
  | "invalid_presets"
  | "invalid_callback";

export const GATEWAY_REFUSAL_KEYS: Record<ResellerGatewayRefusal, string> = K.refusals;

/** The refusal's own sentence key, when the service named one this screen knows. */
export function gatewayRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in GATEWAY_REFUSAL_KEYS ? GATEWAY_REFUSAL_KEYS[reason as ResellerGatewayRefusal] : null;
}
