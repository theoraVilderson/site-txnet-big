import type { Prisma } from '@prisma/client';

/**
 * What a tenant's data export takes of every table (F-212-a, catalog §14.8).
 *
 * One entry per Prisma model, and the type is exhaustive: a model added to the
 * schema does not compile until someone decides here whether it is the
 * tenant's data and how it is reached. `export-tables.spec.ts` (F-212-b) holds
 * the rest against the schema itself — every table named, every column and
 * parent real, every chain ending at the tenant.
 *
 * - `tenant` — the rows whose `column` (default `tenantId`) is the tenant.
 * - `via` — the rows whose `column` names a row of `parent` that is exported.
 * - `none` — not in the archive, and `because` says why.
 *
 * `omit` drops columns that are credentials (§14.8: config metadata, never
 * secrets): a password hash, a sealed token, a VPN client id, a panel login.
 */
export type ExportRule =
  | { rows: 'tenant'; column?: string; omit?: readonly string[] }
  | { rows: 'via'; column: string; parent: Prisma.ModelName; omit?: readonly string[] }
  | { rows: 'none'; because: ExportSkip };

/**
 * - `secret` — key material or a credential; the row is nothing without it.
 * - `platform` — the platform's own configuration, catalog or risk record.
 * - `derived` — rebuilt from rows the archive carries (rollups, profiles).
 * - `operational` — queues, leases, counters and caches of the machinery.
 * - `volume` — a raw log whose totals the archive carries.
 */
export const EXPORT_SKIPS = ['secret', 'platform', 'derived', 'operational', 'volume'] as const;
export type ExportSkip = (typeof EXPORT_SKIPS)[number];

const OWN: ExportRule = { rows: 'tenant' };
const own = (...omit: string[]): ExportRule => ({ rows: 'tenant', omit });
const via = (column: string, parent: Prisma.ModelName, ...omit: string[]): ExportRule => ({ rows: 'via', column, parent, omit });
const none = (because: ExportSkip): ExportRule => ({ rows: 'none', because });

export const EXPORT_TABLES: Readonly<Record<Prisma.ModelName, ExportRule>> = {
  // ai
  AiAccountProfile: none('derived'),
  AiAction: OWN,
  AiGuardrail: OWN,
  AiHoldout: OWN,
  AiMeterReading: OWN,
  AiOffer: OWN,
  AiOptOut: OWN,
  AiPrediction: OWN,
  AiProvider: OWN,
  AiSetting: OWN,
  AiTaskRoute: OWN,
  AiUsage: OWN,
  // audit — rows describing the tenant's people survive and travel (catalog 20.1)
  AccessHistory: OWN,
  AdminAuditLog: OWN,
  EmergencyAccessEntry: OWN,
  ImpersonationSession: via('targetUserId', 'User'),
  LinkedAccountGroup: via('actingAsUserId', 'User'),
  LinkedAccountMember: via('groupId', 'LinkedAccountGroup'),
  SupportAccessConsent: OWN,
  SupportConsentPolicy: OWN,
  // automation — the bot mapping is `BotIntegration`; the token stays in the vault
  BotExecutionLog: none('platform'),
  BotIntegration: own('credentialRef', 'webhookPath'),
  BotSchedule: none('platform'),
  BotWorker: none('platform'),
  DeadLetter: none('operational'),
  OutboxEvent: none('operational'),
  // billing
  AffiliateCommission: via('referralId', 'AffiliateReferral'),
  AffiliateReferral: via('referrerUserId', 'User'),
  AnalyticsCostDay: none('derived'),
  AnalyticsGrantEnd: none('derived'),
  AnalyticsLossAlert: none('derived'),
  AnalyticsMeterDay: none('derived'),
  AnalyticsPanelClientsDay: none('derived'),
  AnalyticsPanelTrafficDay: none('derived'),
  AnalyticsPaymentDay: none('derived'),
  AnalyticsReportSchedule: OWN,
  AnalyticsRollupState: none('derived'),
  AnalyticsSalesDay: none('derived'),
  AnalyticsSetting: OWN,
  AnalyticsSignup: none('derived'),
  AnalyticsSignupDay: none('derived'),
  AnalyticsStockDay: none('derived'),
  AnalyticsUserDay: none('derived'),
  Coupon: OWN,
  CouponAllowedUser: via('couponId', 'Coupon'),
  CouponBatch: OWN,
  CouponGateway: via('couponId', 'Coupon'),
  CouponRedemption: via('userId', 'User'),
  CouponServiceScope: via('couponId', 'Coupon'),
  CryptoPaymentDetail: via('paymentTransactionId', 'PaymentTransaction'),
  CurrencyChange: OWN,
  DepositSetting: OWN,
  DiscountRule: OWN,
  DiscountRuleUser: OWN,
  GatewayAudience: OWN,
  GatewayCommission: OWN,
  GatewaySettlementEntry: OWN,
  GatewaySettlementPayout: OWN,
  GeneralExpense: OWN,
  GeneralExpenseTakeBack: OWN,
  GrantBulkJob: OWN,
  GrantBulkJobItem: OWN,
  GrantBulkOutcome: OWN,
  Invoice: OWN,
  ManualDestination: OWN,
  ManualGatewaySetting: OWN,
  PaymentGateway: none('platform'),
  PaymentGatewayGrant: OWN,
  PaymentReconciliationLog: via('paymentTransactionId', 'PaymentTransaction'),
  PaymentTransaction: OWN,
  PaymentTransferDetail: OWN,
  SpendingCap: OWN,
  TransferTxRef: OWN,
  UsageAuthorization: none('operational'),
  UsageEvent: OWN,
  Wallet: via('ownerUserId', 'User'),
  WalletHold: via('walletId', 'Wallet'),
  WalletTransaction: OWN,
  WalletTransferRequest: via('senderUserId', 'User', 'otpCodeHash'),
  // catalog
  Meter: none('platform'),
  MeterCost: OWN,
  Price: OWN,
  PriceCampaign: OWN,
  Product: OWN,
  ProductAudience: OWN,
  ProductCapability: OWN,
  ProductCategory: OWN,
  ProductCategoryLink: OWN,
  ProductVariant: OWN,
  RateCard: OWN,
  RenewalRate: OWN,
  Season: OWN,
  SeasonPrice: OWN,
  VariantCost: OWN,
  // currency
  Currency: none('platform'),
  CurrencyExchangeRate: OWN,
  CurrencyPolicy: via('userId', 'User'),
  CurrencyRatePinEnd: via('rateId', 'CurrencyExchangeRate'),
  UserCurrencyPreference: via('userId', 'User'),
  // engagement
  AttentionBudget: none('operational'),
  Lottery: OWN,
  LotteryDraw: OWN,
  LotteryEntrant: OWN,
  LotteryPrize: OWN,
  LotteryWinner: OWN,
  RewardIssue: OWN,
  RewardTarget: OWN,
  SpinWheelAttempt: OWN,
  SpinWheelConfig: OWN,
  SpinWheelDay: none('derived'),
  SpinWheelPrize: OWN,
  SpinWheelPrizeDay: none('derived'),
  // entitlement — a Grant's subscription token and an old link's path open a user's configs
  Grant: own('subscriptionTokenHash', 'subscriptionTokenSealed'),
  GrantCompensation: OWN,
  GrantCompensationCap: OWN,
  GrantDeletion: OWN,
  GrantDurationChange: OWN,
  GrantFreezeSetting: OWN,
  GrantLimitSetting: OWN,
  GrantLinkReset: OWN,
  GrantMeter: OWN,
  GrantRenewal: OWN,
  GrantWholesale: OWN,
  LegacySubLink: own('path'),
  MigrationInbound: OWN,
  MigrationItem: own('sourceSnapshot'),
  MigrationRun: OWN,
  QuotaAdjustment: OWN,
  // fraud — the platform's risk signals about people, not the reseller's records
  DeviceFingerprint: none('platform'),
  FraudFlag: none('platform'),
  // governance
  UserGroup: OWN,
  UserGroupMember: OWN,
  UserGroupPermission: OWN,
  UserRestriction: OWN,
  UserSetting: via('userId', 'User'),
  // guide — the reseller's pages
  Guide: OWN,
  GuideDraft: OWN,
  GuideHidden: OWN,
  GuidePlacement: OWN,
  GuideTranslation: OWN,
  GuideViewDaily: OWN,
  GuideVote: OWN,
  // identity
  LinkedBotAccount: OWN,
  OtpCode: none('secret'),
  Permission: none('platform'),
  Role: OWN,
  RolePermission: via('roleId', 'Role'),
  Session: via('userId', 'User', 'refreshTokenHash'),
  User: own('passwordHash', 'twoFactorSecret'),
  UserPermission: OWN,
  // network — a config's metadata; its client id and lines are the VPN credential
  CollectorHeartbeat: none('platform'),
  Config: own('uuid', 'linkLines', 'linksUuid'),
  ConfigActionLog: via('configId', 'Config'),
  ConfigCounterState: none('operational'),
  ConfigMoveJob: OWN,
  ConfigMoveJobItem: OWN,
  ConfigSelfMoveProductSetting: OWN,
  ConfigSelfMoveSetting: OWN,
  GrantRateLimit: via('grantId', 'Grant'),
  InboundRelease: OWN,
  IpAccessRule: none('platform'),
  LeaseClose: none('operational'),
  Panel: own('panelApiCredentials', 'panelRadiusSecret', 'ovpnProfile', 'anchorUuid'),
  PanelCost: via('panelId', 'Panel'),
  PanelDriftEvent: none('operational'),
  PanelGroup: OWN,
  PanelGroupMember: OWN,
  PanelGroupMemberInbound: OWN,
  PanelInbound: OWN,
  RadiusSession: none('operational'),
  TrafficDailyAggregate: via('configId', 'Config'),
  TrafficRawLog: none('volume'),
  UnattributedUsage: none('operational'),
  UsageDeltaQuarantine: none('operational'),
  UsageDeltaSeen: none('operational'),
  UsageHold: none('operational'),
  // notification
  Notification: via('userId', 'User'),
  NotificationCampaign: OWN,
  NotificationCampaignRecipient: via('campaignId', 'NotificationCampaign'),
  NotificationCampaignText: via('campaignId', 'NotificationCampaign'),
  NotificationGrantPreference: via('userId', 'User'),
  NotificationPreference: via('userId', 'User'),
  RetentionNotice: via('userId', 'User'),
  // storage — the file index; the bytes stay on the storage port
  StoredObject: OWN,
  // support
  SupportCannedReply: OWN,
  SupportCannedReplyText: OWN,
  SupportCategory: OWN,
  SupportCategoryText: OWN,
  SupportConversation: OWN,
  SupportConversationRead: OWN,
  SupportLifecyclePolicy: OWN,
  SupportMessage: OWN,
  SupportMessageAttachment: OWN,
  SupportSlaPolicy: OWN,
  SupportWorkingHours: OWN,
  // tenant — the reseller itself, its themes and domains; the package price list is the platform's
  PackageLimit: none('platform'),
  PackageProduct: none('platform'),
  PackageQuotaOverage: none('platform'),
  QuotaOverageSetting: none('platform'),
  ResellerLimit: OWN,
  ResellerLimitSetting: none('platform'),
  ResellerOverageCap: OWN,
  ResellerQuotaAlert: OWN,
  ResellerQuotaOverage: OWN,
  ResellerQuotaRefusal: OWN,
  ResellerQuotaTermsLock: OWN,
  ResellerQuotaUsage: OWN,
  Tenant: { rows: 'tenant', column: 'id' },
  TenantBillingTransaction: via('walletId', 'TenantBillingWallet'),
  TenantBillingWallet: OWN,
  TenantBranding: OWN,
  TenantCredential: none('secret'),
  TenantCredentialAccess: OWN,
  TenantDataExport: OWN,
  TenantDek: none('secret'),
  TenantDomain: own('verificationToken'),
  TenantFeatureEntitlement: OWN,
  TenantFeaturePackage: none('platform'),
  TenantGatewayConfig: own('merchantIdEncrypted', 'apiKeyEncrypted'),
  TenantOnboardingSkip: OWN,
  TenantPackageMeterRate: none('platform'),
  TenantSmsConfig: OWN,
  TenantStaffMember: OWN,
  TenantStatusHistory: OWN,
  TenantSubscription: OWN,
  TenantSubscriptionSetting: none('platform'),
  TenantUsageMeter: OWN,
};
