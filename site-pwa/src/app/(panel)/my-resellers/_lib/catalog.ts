import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { CatalogRejection } from "@/lib/catalog-api";

/** The screen's own strings as generated constants (C-06); the page itself keeps `common.catalog`. */
export const RESELLER_CATALOG_KEYS = FrontendI18nKeys.common.resellerCatalog;
const K = RESELLER_CATALOG_KEYS;

/**
 * Every reason `/api/catalog/tenants/:tenantId/...` refuses with — both doors:
 * shared-core's `ResellerAccessRejection` (who may configure this reseller,
 * invariant 21) and billing's `CatalogAdminRejection` (what may be done to the
 * catalog). The spec reads the union from the controller's own exhaustive
 * `STATUS` map, so a reason added there has no sentence here until it is
 * written.
 */
export type ResellerCatalogRefusal = "not_allowed" | "reseller_not_found" | "reseller_suspended" | "reseller_terminated" | CatalogRejection;

export const CATALOG_REFUSAL_KEYS: Record<ResellerCatalogRefusal, string> = { ...K.refusals, audience_not_allowed: FrontendI18nKeys.common.audience.notAllowed };

/** The refusal's own sentence key, when the service named one this screen knows. */
export function catalogRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in CATALOG_REFUSAL_KEYS ? CATALOG_REFUSAL_KEYS[reason as ResellerCatalogRefusal] : null;
}
