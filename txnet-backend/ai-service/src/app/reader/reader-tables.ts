/**
 * The tables `ai-service`'s reader may SELECT (ADR-0109 point 6), each under
 * its tenant's RLS. `20261002000300_ai_reader_role` grants exactly these and
 * `reader-role.spec.ts` holds the two lists together: a table added here
 * without its grant reads as permission denied, never as another tenant's rows.
 *
 * `sharedRead` mirrors the table's own app policy: the platform's catalog and
 * coupons (`tenantId` NULL) are visible to every tenant.
 *
 * Not here, on purpose: anything under `network` (no network-layer data,
 * ADR-0109 point 6); tables keyed by user with no `tenantId` (`billing.wallet`,
 * `identity.session`, `notification.*`) — RLS cannot scope them, so F-038-c
 * reaches them another way or not at all.
 */
export const AI_READER_TABLES = [
  { table: 'identity.user', sharedRead: false },
  { table: 'entitlement.grant', sharedRead: false },
  { table: 'entitlement.grant_meter', sharedRead: false },
  { table: 'entitlement.grant_renewal', sharedRead: false },
  { table: 'billing.wallet_transaction', sharedRead: false },
  { table: 'billing.payment_transaction', sharedRead: false },
  { table: 'billing.invoice', sharedRead: false },
  { table: 'billing.coupon', sharedRead: true },
  { table: 'catalog.product', sharedRead: true },
  { table: 'catalog.product_variant', sharedRead: true },
  { table: 'catalog.price', sharedRead: true },
  { table: 'tenant.tenant_subscription', sharedRead: false },
  { table: 'tenant.tenant_feature_entitlement', sharedRead: false },
  { table: 'tenant.reseller_limit', sharedRead: false },
  { table: 'tenant.reseller_quota_usage', sharedRead: false },
] as const;
