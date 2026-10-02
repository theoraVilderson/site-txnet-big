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
 * `identity.session`, `notification.notification`, `notification.notification_preference`, `support.ticket`) — they have no RLS, so
 * they are read through {@link AI_READER_VIEWS} instead.
 */
export const AI_READER_TABLES = [
  { table: 'identity.user', sharedRead: false },
  { table: 'entitlement.grant', sharedRead: false },
  { table: 'entitlement.grant_meter', sharedRead: false },
  { table: 'entitlement.grant_renewal', sharedRead: false },
  // F-038-p: the wholesale rate a reseller's Grant locked — the cost in the margin.
  { table: 'entitlement.grant_wholesale', sharedRead: false },
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
  // F-038-o1: a reseller's own quota terms, read in that reseller's scope.
  { table: 'tenant.reseller_quota_overage', sharedRead: false },
  { table: 'tenant.reseller_quota_terms_lock', sharedRead: false },
] as const;

/**
 * The platform's own quota terms (F-038-o1, `20261002001600_ai_reseller_inputs`):
 * one row per key or package, no `tenantId` and no RLS — what a reseller's
 * statement is resolved against (shared-core `quotaTermsOf`,
 * `productQuotaStatementsOf`). `tenant.tenant` is its type by id, by named
 * columns: never its owner, slug or status.
 */
export const AI_READER_PLATFORM_TABLES = [
  { table: 'tenant.tenant', columns: ['id', 'tenantType', 'deletedAt'] },
  { table: 'tenant.tenant_subscription_setting', columns: null },
  { table: 'tenant.package_limit', columns: null },
  { table: 'tenant.reseller_limit_setting', columns: null },
  { table: 'tenant.quota_overage_setting', columns: null },
  { table: 'tenant.package_quota_overage', columns: null },
  { table: 'tenant.package_product', columns: null },
  // F-038-o4: the packages an upgrade may name (`20261002001700_ai_reseller_upgrade_inputs`).
  { table: 'tenant.tenant_feature_package', columns: null },
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
  {
    // F-1506: the quiet-down step's open tickets (`20261002000600_ai_quiet_down_inputs`).
    view: 'ai.reader_open_ticket',
    over: 'support.ticket',
    columns: ['userId', 'createdAt'],
    forbidden: ['subject', 'assignedAdminId'],
  },
  {
    // F-038-e: the quiet window a suggestion is scheduled outside (`20261002000700_ai_decision_inputs`).
    view: 'ai.reader_quiet_hours',
    over: 'notification.notification_preference',
    columns: ['userId', 'quietStart', 'quietEnd', 'timezone'],
    forbidden: ['mutedKinds'],
  },
  {
    // F-1528: the tenant's own package rates, for the margin report (`20261002001400_ai_package_rate_view`).
    view: 'ai.reader_package_rate',
    over: 'tenant.tenant_package_meter_rate',
    columns: ['meterKey', 'unitSize', 'unitPrice', 'currencyCode', 'effectiveFrom'],
    forbidden: ['packageId', 'createdByAdminId'],
  },
  {
    // F-038-o1: the platform's resellers — empty unless the bound tenant is the platform owner (`20261002001600_ai_reseller_inputs`).
    view: 'ai.reader_reseller',
    over: 'tenant.tenant',
    columns: ['tenantId', 'ownerUserId', 'packageId', 'currentPeriodEnd', 'renewalWarnedAt', 'graceUntil', 'nextPackageId', 'monthlyPrice', 'yearlyPrice', 'walletBalance', 'walletCurrency'],
    forbidden: ['slug', 'suspendedReason'],
  },
] as const;
