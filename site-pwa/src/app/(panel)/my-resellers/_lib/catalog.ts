import { FrontendI18nKeys } from "@/generated/i18n-keys";

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
export type ResellerCatalogRefusal =
  | "not_allowed"
  | "reseller_not_found"
  | "reseller_suspended"
  | "reseller_terminated"
  | "not_platform_owner"
  | "tenant_not_found"
  | "category_not_found"
  | "product_not_found"
  | "variant_not_found"
  | "price_not_found"
  | "key_taken"
  | "sku_taken"
  | "price_in_the_past"
  | "panel_group_not_found"
  | "text_key_invalid"
  | "texts_unavailable"
  | "lang_unknown"
  | "source_text_missing"
  | "category_cycle"
  | "category_too_deep"
  | "capability_not_found"
  | "capability_unknown"
  | "capability_in_use"
  | "traffic_quota_required"
  | "meter_not_found"
  | "rate_card_not_found"
  | "rate_card_not_served";

export const CATALOG_REFUSAL_KEYS: Record<ResellerCatalogRefusal, string> = K.refusals;

/** The refusal's own sentence key, when the service named one this screen knows. */
export function catalogRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in CATALOG_REFUSAL_KEYS ? CATALOG_REFUSAL_KEYS[reason as ResellerCatalogRefusal] : null;
}
