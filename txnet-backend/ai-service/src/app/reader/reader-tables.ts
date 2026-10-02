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
 * `identity.session`, `notification.notification`) — they have no RLS, so
 * they are read through {@link AI_READER_VIEWS} instead.
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
  // F-038-d: the top-up presets a wallet need is rounded up to.
  { table: 'billing.deposit_setting', sharedRead: false },
  { table: 'catalog.product', sharedRead: true },
  { table: 'catalog.product_variant', sharedRead: true },
  { table: 'catalog.price', sharedRead: true },
  { table: 'tenant.tenant_subscription', sharedRead: false },
  { table: 'tenant.tenant_feature_entitlement', sharedRead: false },
  { table: 'tenant.reseller_limit', sharedRead: false },
  { table: 'tenant.reseller_quota_usage', sharedRead: false },
] as const;

/**
 * The views over tables keyed by user with no `tenantId` (F-038-c,
 * `20261002000400_ai_profile_inputs`): each scopes by the row's user's tenant
 * and exposes only `columns`. Read with raw SQL — Prisma has no model for them.
 * `forbidden` is what each view must never carry; the spec checks both.
 */
export const AI_READER_VIEWS = [
  {
    view: 'ai.reader_sign_in',
    over: 'identity.session',
    columns: ['userId', 'issuedAt', 'deviceLabel'],
    forbidden: ['ipAddress', 'userAgent', 'refreshTokenHash'],
  },
  {
    view: 'ai.reader_notice',
    over: 'notification.notification',
    columns: ['userId', 'type', 'createdAt', 'readAt'],
    forbidden: ['title', 'body'],
  },
  {
    view: 'ai.reader_wallet',
    over: 'billing.wallet',
    columns: ['id', 'userId', 'cachedBalance', 'heldAmount', 'currencyCode'],
    forbidden: ['version'],
  },
] as const;
