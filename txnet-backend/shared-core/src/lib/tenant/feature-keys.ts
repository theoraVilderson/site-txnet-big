/**
 * The feature keys a tenant can be entitled to — declared once (C-09).
 *
 * A package's `includedFeatureKeys` (F-018-d) and a
 * `tenant_feature_entitlement.featureKey` (F-018-e, tenant invariant 6) are
 * members of this tuple. A new sellable feature adds its key here first.
 */
export const TENANT_FEATURE_KEYS = [
  'ai_recommendation',
  'spin_wheel',
  'affiliate_system',
  'coupon_engine',
  'custom_bot_telegram',
  'custom_bot_bale',
  'own_gateway',
  'own_sms',
  'multi_currency',
  'dedicated_node_pool',
] as const;

export type TenantFeatureKey = (typeof TENANT_FEATURE_KEYS)[number];
