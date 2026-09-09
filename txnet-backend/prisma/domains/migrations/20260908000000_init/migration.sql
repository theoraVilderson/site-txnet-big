-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "ai";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "audit";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "automation";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "billing";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "catalog";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "currency";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "engagement";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "fraud";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "governance";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "identity";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "network";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "notification";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "support";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "tenant";

-- CreateEnum
CREATE TYPE "ai"."BehaviorEventType" AS ENUM ('low_balance', 'config_expiring_soon', 'usage_spike', 'ticket_opened', 'payment_failed', 'spin_wheel_played', 'coupon_viewed_not_redeemed', 'long_inactive');

-- CreateEnum
CREATE TYPE "ai"."RecommendationType" AS ENUM ('renew_plan', 'buy_addon_gb', 'apply_coupon', 'upgrade_package', 'retention_offer');

-- CreateEnum
CREATE TYPE "ai"."RecommendationStatus" AS ENUM ('proposed', 'shown_to_user', 'accepted', 'dismissed', 'expired', 'blocked_by_guardrail');

-- CreateEnum
CREATE TYPE "ai"."GuardrailRuleType" AS ENUM ('max_discount_percent_per_recommendation', 'max_daily_discount_budget_total', 'max_recommendations_per_user_per_day', 'min_confidence_threshold');

-- CreateEnum
CREATE TYPE "ai"."GuardrailAction" AS ENUM ('recommendation_blocked', 'recommendation_capped', 'escalated_to_admin_review');

-- CreateEnum
CREATE TYPE "audit"."AdminAction" AS ENUM ('wallet_manual_adjust', 'user_ban', 'user_unban', 'config_force_disable', 'role_change', 'gateway_toggle', 'coupon_create_targeted', 'payment_manual_confirm', 'currency_policy_lock', 'restriction_assign', 'bot_toggle', 'user_impersonate_start', 'user_impersonate_end', 'tenant_suspend', 'tenant_settlement_approve', 'tenant_feature_grant', 'tenant_gateway_config_change', 'tenant_domain_verify');

-- CreateEnum
CREATE TYPE "audit"."AuditTargetType" AS ENUM ('user', 'wallet', 'config', 'gateway', 'coupon', 'payment', 'currency_policy', 'bot_worker', 'restriction');

-- CreateEnum
CREATE TYPE "automation"."BotWorkerCategory" AS ENUM ('campaign', 'fraud_detection', 'data_aggregation', 'ai_task', 'payment_reconciliation', 'other');

-- CreateEnum
CREATE TYPE "automation"."ScheduleType" AS ENUM ('always_on', 'time_window', 'cron_expression');

-- CreateEnum
CREATE TYPE "automation"."TriggerSource" AS ENUM ('cron', 'admin_manual', 'event');

-- CreateEnum
CREATE TYPE "automation"."ExecutionStatus" AS ENUM ('success', 'failed', 'partial');

-- CreateEnum
CREATE TYPE "billing"."LedgerDirection" AS ENUM ('credit', 'debit');

-- CreateEnum
CREATE TYPE "billing"."WalletReasonType" AS ENUM ('payment_gateway', 'coupon_redemption', 'traffic_consumption', 'admin_manual_adjust', 'affiliate_commission', 'sub_account_charge', 'wallet_transfer_in', 'wallet_transfer_out');

-- CreateEnum
CREATE TYPE "billing"."TransferStatus" AS ENUM ('pending_otp', 'confirmed', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "billing"."CouponVisibility" AS ENUM ('public', 'targeted');

-- CreateEnum
CREATE TYPE "billing"."RedemptionStatus" AS ENUM ('pending', 'confirmed', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "billing"."PaymentProviderName" AS ENUM ('zarinpal', 'idpay', 'nowpayments', 'stripe');

-- CreateEnum
CREATE TYPE "billing"."GatewayCategory" AS ENUM ('domestic_rial', 'international_card', 'crypto');

-- CreateEnum
CREATE TYPE "billing"."FeeCalcMode" AS ENUM ('manual', 'automatic');

-- CreateEnum
CREATE TYPE "billing"."FeeType" AS ENUM ('fixed', 'percentage');

-- CreateEnum
CREATE TYPE "billing"."ConfirmationMode" AS ENUM ('automatic', 'manual_admin_required');

-- CreateEnum
CREATE TYPE "billing"."PaymentStatus" AS ENUM ('pending', 'success', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "billing"."ConfirmationSource" AS ENUM ('webhook_auto', 'reconciliation_auto', 'admin_manual');

-- CreateEnum
CREATE TYPE "billing"."ReconciliationAction" AS ENUM ('auto_confirmed', 'no_action_needed', 'flagged_mismatch');

-- CreateEnum
CREATE TYPE "billing"."CryptoAsset" AS ENUM ('USDT', 'BTC', 'ETH');

-- CreateEnum
CREATE TYPE "billing"."CryptoNetwork" AS ENUM ('TRC20', 'ERC20', 'BEP20', 'Bitcoin');

-- CreateEnum
CREATE TYPE "billing"."CommissionStatus" AS ENUM ('pending', 'paid');

-- CreateEnum
CREATE TYPE "catalog"."ServicePlanBillingModel" AS ENUM ('pay_as_you_go', 'fixed_package', 'one_time');

-- CreateEnum
CREATE TYPE "catalog"."DiscountType" AS ENUM ('percentage', 'fixed_amount');

-- CreateEnum
CREATE TYPE "currency"."RateSource" AS ENUM ('manual_admin', 'external_api');

-- CreateEnum
CREATE TYPE "currency"."PolicyScope" AS ENUM ('global', 'user');

-- CreateEnum
CREATE TYPE "engagement"."SpinPrizeType" AS ENUM ('wallet_credit', 'discount_coupon', 'bonus_traffic_gb', 'empty');

-- CreateEnum
CREATE TYPE "engagement"."SpinAttemptStatus" AS ENUM ('awarded', 'voided_fraud', 'rejected_ineligible');

-- CreateEnum
CREATE TYPE "fraud"."FraudSubjectType" AS ENUM ('user', 'config', 'wallet_transfer', 'coupon_redemption', 'spin_attempt', 'affiliate_referral');

-- CreateEnum
CREATE TYPE "fraud"."FraudFlagType" AS ENUM ('multi_account_same_device', 'self_referral', 'rapid_wallet_transfer_loop', 'coupon_abuse_pattern', 'config_ip_sharing', 'torrent_traffic_detected', 'spin_wheel_multi_accounting');

-- CreateEnum
CREATE TYPE "fraud"."FraudSeverity" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "fraud"."FraudAutoAction" AS ENUM ('none', 'freeze_config', 'block_transfer', 'hold_coupon', 'require_manual_review');

-- CreateEnum
CREATE TYPE "governance"."SettingCategory" AS ENUM ('notification', 'privacy', 'security', 'display', 'billing', 'other');

-- CreateEnum
CREATE TYPE "governance"."GrantResourceType" AS ENUM ('config', 'feature', 'service_plan');

-- CreateEnum
CREATE TYPE "governance"."GrantMode" AS ENUM ('one_time', 'recurring_daily');

-- CreateEnum
CREATE TYPE "governance"."RestrictionScope" AS ENUM ('soft_warning', 'hard_block');

-- CreateEnum
CREATE TYPE "identity"."UserStatus" AS ENUM ('active', 'banned', 'suspended');

-- CreateEnum
CREATE TYPE "identity"."ThemePreference" AS ENUM ('light', 'dark', 'system');

-- CreateEnum
CREATE TYPE "identity"."Language" AS ENUM ('fa', 'en');

-- CreateEnum
CREATE TYPE "identity"."SessionRevokedReason" AS ENUM ('user_logout', 'password_change', 'admin_ban', 'expired', 'impersonation_ended', 'account_switched', 'account_unlinked');

-- CreateEnum
CREATE TYPE "identity"."SocialPlatform" AS ENUM ('telegram', 'bale');

-- CreateEnum
CREATE TYPE "identity"."OtpPurpose" AS ENUM ('login', 'register_phone_verify', 'password_reset', 'account_link', 'account_switch_link');

-- CreateEnum
CREATE TYPE "identity"."OtpChannel" AS ENUM ('sms', 'bale', 'telegram');

-- CreateEnum
CREATE TYPE "network"."PanelType" AS ENUM ('x_ui', 'core_xray');

-- CreateEnum
CREATE TYPE "network"."PanelRole" AS ENUM ('active', 'passive');

-- CreateEnum
CREATE TYPE "network"."PanelStatus" AS ENUM ('healthy', 'degraded', 'maintenance', 'down');

-- CreateEnum
CREATE TYPE "network"."ConfigProtocol" AS ENUM ('vmess', 'vless', 'trojan', 'shadowsocks');

-- CreateEnum
CREATE TYPE "network"."ConfigStatus" AS ENUM ('active', 'frozen', 'disabled_by_admin', 'disabled_by_system');

-- CreateEnum
CREATE TYPE "network"."ActorType" AS ENUM ('user', 'admin', 'system');

-- CreateEnum
CREATE TYPE "network"."IpRuleType" AS ENUM ('block', 'allow_always', 'custom_rate_limit');

-- CreateEnum
CREATE TYPE "notification"."NotificationType" AS ENUM ('system_alert', 'admin_message', 'low_balance');

-- CreateEnum
CREATE TYPE "notification"."NotificationChannel" AS ENUM ('push', 'sms', 'telegram_bot', 'bale_bot');

-- CreateEnum
CREATE TYPE "notification"."CampaignStatus" AS ENUM ('draft', 'sending', 'completed');

-- CreateEnum
CREATE TYPE "notification"."DeliveryStatus" AS ENUM ('queued', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "support"."TicketStatus" AS ENUM ('open', 'pending', 'closed');

-- CreateEnum
CREATE TYPE "support"."TicketPriority" AS ENUM ('low', 'medium', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "support"."SenderType" AS ENUM ('user', 'admin');

-- CreateEnum
CREATE TYPE "support"."ChatSessionStatus" AS ENUM ('active', 'closed');

-- CreateEnum
CREATE TYPE "tenant"."TenantType" AS ENUM ('platform_owner', 'reseller');

-- CreateEnum
CREATE TYPE "tenant"."TenantStatus" AS ENUM ('trial', 'active', 'suspended', 'terminated');

-- CreateEnum
CREATE TYPE "tenant"."TenantBillingModel" AS ENUM ('subscription_monthly', 'subscription_yearly', 'pay_as_you_go_metered');

-- CreateEnum
CREATE TYPE "tenant"."TenantDomainType" AS ENUM ('subdomain', 'custom_domain');

-- CreateEnum
CREATE TYPE "tenant"."DomainVerificationStatus" AS ENUM ('pending', 'verified', 'failed');

-- CreateEnum
CREATE TYPE "tenant"."EntitlementSource" AS ENUM ('package_included', 'addon_purchased', 'admin_granted');

-- CreateEnum
CREATE TYPE "tenant"."TenantStaffRole" AS ENUM ('owner', 'admin', 'support', 'finance_viewer');

-- CreateEnum
CREATE TYPE "tenant"."TenantLedgerDirection" AS ENUM ('credit', 'debit');

-- CreateEnum
CREATE TYPE "tenant"."TenantBillingReasonType" AS ENUM ('topup_payment', 'subscription_charge', 'metered_usage_charge', 'sms_usage_charge', 'admin_manual_adjust');

-- CreateEnum
CREATE TYPE "tenant"."TenantMeterKey" AS ENUM ('active_configs_count', 'sms_sent', 'ai_recommendation_calls', 'custom_bot_messages', 'storage_gb');

-- CreateEnum
CREATE TYPE "tenant"."TenantGatewayVerificationStatus" AS ENUM ('pending_test_transaction', 'verified', 'failed');

-- CreateEnum
CREATE TYPE "tenant"."TenantSmsMode" AS ENUM ('use_platform_sms', 'own_credentials');

-- CreateTable
CREATE TABLE "ai"."user_behavior_event" (
    "id" BIGSERIAL NOT NULL,
    "userId" UUID NOT NULL,
    "eventType" "ai"."BehaviorEventType" NOT NULL,
    "eventPayload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_behavior_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."ai_recommendation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "recommendationType" "ai"."RecommendationType" NOT NULL,
    "suggestedPayload" JSONB NOT NULL,
    "confidenceScore" DECIMAL(5,4) NOT NULL,
    "estimatedRevenueImpact" DECIMAL(18,2),
    "estimatedCostImpact" DECIMAL(18,2),
    "status" "ai"."RecommendationStatus" NOT NULL DEFAULT 'proposed',
    "generatedByBotWorkerId" UUID,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."ai_guardrail_rule" (
    "id" UUID NOT NULL,
    "ruleName" TEXT NOT NULL,
    "ruleType" "ai"."GuardrailRuleType" NOT NULL,
    "thresholdValue" DECIMAL(18,4) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ai_guardrail_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."ai_guardrail_violation_log" (
    "id" UUID NOT NULL,
    "recommendationId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "violatedValue" DECIMAL(18,4) NOT NULL,
    "actionTaken" "ai"."GuardrailAction" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_guardrail_violation_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit"."admin_audit_log" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "adminId" UUID NOT NULL,
    "action" "audit"."AdminAction" NOT NULL,
    "targetEntityType" "audit"."AuditTargetType" NOT NULL,
    "targetEntityId" UUID NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "adminIpAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit"."impersonation_session" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "targetUserId" UUID NOT NULL,
    "reasonNote" TEXT NOT NULL,
    "linkedTicketId" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "adminIpAddress" TEXT NOT NULL,

    CONSTRAINT "impersonation_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit"."linked_account_group" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "linked_account_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit"."linked_account_member" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedViaOtp" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "linked_account_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation"."bot_worker" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "automation"."BotWorkerCategory" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation"."bot_schedule" (
    "id" UUID NOT NULL,
    "botWorkerId" UUID NOT NULL,
    "scheduleType" "automation"."ScheduleType" NOT NULL,
    "windowStartAt" TIMESTAMP(3),
    "windowEndAt" TIMESTAMP(3),
    "cronExpression" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Tehran',
    "setByAdminId" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "bot_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation"."bot_execution_log" (
    "id" UUID NOT NULL,
    "botWorkerId" UUID NOT NULL,
    "triggeredBy" "automation"."TriggerSource" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "automation"."ExecutionStatus" NOT NULL,
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "errorsCount" INTEGER NOT NULL DEFAULT 0,
    "metricsJson" JSONB,

    CONSTRAINT "bot_execution_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."wallet" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "cachedBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."wallet_transaction" (
    "id" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "tenantId" UUID,
    "amount" DECIMAL(18,2) NOT NULL,
    "direction" "billing"."LedgerDirection" NOT NULL,
    "reasonType" "billing"."WalletReasonType" NOT NULL,
    "referenceId" UUID,
    "balanceAfter" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."sub_account" (
    "id" UUID NOT NULL,
    "parentWalletId" UUID NOT NULL,
    "configId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "dataCapBytes" BIGINT NOT NULL,
    "consumedBytes" BIGINT NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "sub_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."wallet_transfer_request" (
    "id" UUID NOT NULL,
    "senderUserId" UUID NOT NULL,
    "receiverUserId" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "status" "billing"."TransferStatus" NOT NULL DEFAULT 'pending_otp',
    "otpCodeHash" TEXT NOT NULL,
    "otpExpiresAt" TIMESTAMP(3) NOT NULL,
    "otpAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "wallet_transfer_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."coupon" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "code" TEXT NOT NULL,
    "discountType" "catalog"."DiscountType" NOT NULL,
    "discountValue" DECIMAL(18,2) NOT NULL,
    "maxDiscountCap" DECIMAL(18,2),
    "minPurchaseAmount" DECIMAL(18,2),
    "totalUsageLimit" INTEGER,
    "perUserUsageLimit" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "reservedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "visibility" "billing"."CouponVisibility" NOT NULL DEFAULT 'public',
    "createdByAdminId" UUID NOT NULL,

    CONSTRAINT "coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."coupon_service_scope" (
    "id" UUID NOT NULL,
    "couponId" UUID NOT NULL,
    "servicePlanId" UUID,
    "categoryId" UUID,

    CONSTRAINT "coupon_service_scope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."coupon_allowed_user" (
    "id" UUID NOT NULL,
    "couponId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "coupon_allowed_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."coupon_redemption" (
    "id" UUID NOT NULL,
    "couponId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "billing"."RedemptionStatus" NOT NULL DEFAULT 'pending',
    "paymentTransactionId" UUID,
    "discountAppliedAmount" DECIMAL(18,2) NOT NULL,
    "orderReferenceId" UUID NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_redemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."payment_gateway" (
    "id" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "providerName" "billing"."PaymentProviderName" NOT NULL,
    "gatewayCategory" "billing"."GatewayCategory" NOT NULL,
    "supportedCurrencies" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "merchantId" TEXT NOT NULL,
    "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "minAcceptAmount" DECIMAL(18,2) NOT NULL,
    "maxAcceptAmount" DECIMAL(18,2) NOT NULL,
    "feeCalculationMode" "billing"."FeeCalcMode" NOT NULL,
    "feeType" "billing"."FeeType" NOT NULL,
    "feeValue" DECIMAL(18,4) NOT NULL,
    "feeFloor" DECIMAL(18,2),
    "feeCeiling" DECIMAL(18,2),
    "confirmationMode" "billing"."ConfirmationMode" NOT NULL DEFAULT 'automatic',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_gateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."payment_transaction" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "userId" UUID NOT NULL,
    "gatewayId" UUID NOT NULL,
    "amountRequested" DECIMAL(18,2) NOT NULL,
    "feeApplied" DECIMAL(18,2) NOT NULL,
    "status" "billing"."PaymentStatus" NOT NULL DEFAULT 'pending',
    "gatewayTrackingCode" TEXT,
    "couponId" UUID,
    "confirmationSource" "billing"."ConfirmationSource",
    "confirmedByAdminId" UUID,
    "manualConfirmReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "payment_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."payment_reconciliation_log" (
    "id" UUID NOT NULL,
    "paymentTransactionId" UUID NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gatewayReportedStatus" TEXT NOT NULL,
    "actionTaken" "billing"."ReconciliationAction" NOT NULL,
    "notes" TEXT,

    CONSTRAINT "payment_reconciliation_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."crypto_payment_detail" (
    "id" UUID NOT NULL,
    "paymentTransactionId" UUID NOT NULL,
    "cryptoAsset" "billing"."CryptoAsset" NOT NULL,
    "network" "billing"."CryptoNetwork" NOT NULL,
    "depositAddress" TEXT NOT NULL,
    "requiredConfirmations" INTEGER NOT NULL,
    "receivedConfirmations" INTEGER NOT NULL DEFAULT 0,
    "exchangeRateSnapshot" DECIMAL(18,8) NOT NULL,
    "txHash" TEXT,

    CONSTRAINT "crypto_payment_detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."affiliate_referral" (
    "id" UUID NOT NULL,
    "referrerUserId" UUID NOT NULL,
    "referredUserId" UUID NOT NULL,
    "signedUpAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."affiliate_commission" (
    "id" UUID NOT NULL,
    "referralId" UUID NOT NULL,
    "triggeringPaymentId" UUID NOT NULL,
    "commissionAmount" DECIMAL(18,2) NOT NULL,
    "status" "billing"."CommissionStatus" NOT NULL DEFAULT 'pending',
    "payoutWalletTransactionId" UUID,

    CONSTRAINT "affiliate_commission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."product_category" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "product_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."service_plan" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "categoryId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "billingModel" "catalog"."ServicePlanBillingModel" NOT NULL,
    "basePrice" DECIMAL(18,2),
    "pricePerUnit" DECIMAL(18,8),
    "unitLabel" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "attributesJson" JSONB NOT NULL,

    CONSTRAINT "service_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog"."service_plan_promotion" (
    "id" UUID NOT NULL,
    "servicePlanId" UUID NOT NULL,
    "discountType" "catalog"."DiscountType" NOT NULL,
    "discountValue" DECIMAL(18,2) NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "service_plan_promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency"."currency" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimalPlaces" INTEGER NOT NULL DEFAULT 0,
    "isBaseCurrency" BOOLEAN NOT NULL DEFAULT false,
    "isSelectableByUser" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "currency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency"."currency_exchange_rate" (
    "id" UUID NOT NULL,
    "currencyId" UUID NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "source" "currency"."RateSource" NOT NULL,
    "setByAdminId" UUID,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "currency_exchange_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency"."user_currency_preference" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "preferredCurrencyId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_currency_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency"."currency_policy" (
    "id" UUID NOT NULL,
    "scope" "currency"."PolicyScope" NOT NULL,
    "userId" UUID,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "enforcedCurrencyId" UUID,
    "setByAdminId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "currency_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement"."spin_wheel_config" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "dailyBudgetCapAmount" DECIMAL(18,2) NOT NULL,
    "perUserCooldownHours" INTEGER NOT NULL DEFAULT 24,
    "requiresMinAccountAgeHours" INTEGER NOT NULL DEFAULT 24,
    "requiresMinTotalPurchaseAmount" DECIMAL(18,2),
    "requiresMinCompletedOrdersCount" INTEGER,
    "requiresActiveServiceAtSpinTime" BOOLEAN NOT NULL DEFAULT true,
    "maxSpinsPerAccountPerDay" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "spin_wheel_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement"."spin_wheel_prize" (
    "id" UUID NOT NULL,
    "wheelConfigId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "prizeType" "engagement"."SpinPrizeType" NOT NULL,
    "prizeValue" DECIMAL(18,2) NOT NULL,
    "probabilityWeight" INTEGER NOT NULL,
    "dailyStockLimit" INTEGER,
    "currentDayAwardedCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "spin_wheel_prize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement"."spin_wheel_attempt" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceFingerprintId" UUID NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eligibilityCheckSnapshotJson" JSONB NOT NULL,
    "prizeAwardedId" UUID,
    "resultWalletTransactionId" UUID,
    "status" "engagement"."SpinAttemptStatus" NOT NULL,

    CONSTRAINT "spin_wheel_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fraud"."device_fingerprint" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fingerprintHash" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_fingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fraud"."fraud_flag" (
    "id" UUID NOT NULL,
    "subjectType" "fraud"."FraudSubjectType" NOT NULL,
    "subjectId" UUID NOT NULL,
    "flagType" "fraud"."FraudFlagType" NOT NULL,
    "severity" "fraud"."FraudSeverity" NOT NULL,
    "autoActionTaken" "fraud"."FraudAutoAction" NOT NULL DEFAULT 'none',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByAdminId" UUID,
    "notes" TEXT,

    CONSTRAINT "fraud_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance"."user_setting" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "category" "governance"."SettingCategory" NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance"."temporal_access_grant" (
    "id" UUID NOT NULL,
    "granteeUserId" UUID NOT NULL,
    "grantedByAdminId" UUID,
    "permissionKey" TEXT NOT NULL,
    "resourceType" "governance"."GrantResourceType",
    "resourceId" UUID,
    "grantMode" "governance"."GrantMode" NOT NULL,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "dailyStartTime" TIME,
    "dailyEndTime" TIME,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Tehran',
    "validFrom" DATE,
    "validUntil" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temporal_access_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance"."user_restriction" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "restrictionKey" TEXT NOT NULL,
    "limitValueJson" JSONB NOT NULL,
    "scope" "governance"."RestrictionScope" NOT NULL,
    "reason" TEXT,
    "setByAdminId" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_restriction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."user" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "fullName" TEXT NOT NULL,
    "username" TEXT,
    "phoneNumber" TEXT,
    "phoneVerifiedAt" TIMESTAMP(3),
    "passwordHash" TEXT NOT NULL,
    "roleId" UUID NOT NULL,
    "status" "identity"."UserStatus" NOT NULL DEFAULT 'active',
    "theme" "identity"."ThemePreference" NOT NULL DEFAULT 'system',
    "languagePreference" "identity"."Language" NOT NULL DEFAULT 'fa',
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "preferredOtpChannel" "identity"."OtpChannel",
    "referredByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "deviceLabel" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" "identity"."SessionRevokedReason",
    "isImpersonated" BOOLEAN NOT NULL DEFAULT false,
    "impersonationSessionId" UUID,
    "switchedFromUserId" UUID,
    "scopeKey" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."role" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isSystemRole" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."permission" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."role_permission" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "identity"."otp_code" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "phoneNumber" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" "identity"."OtpPurpose" NOT NULL,
    "channel" "identity"."OtpChannel" NOT NULL DEFAULT 'sms',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "requestIp" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."linked_bot_account" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "platform" "identity"."SocialPlatform" NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "contactVerifiedAt" TIMESTAMP(3),
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "linked_bot_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network"."panel" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "name" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "panelType" "network"."PanelType" NOT NULL,
    "panelApiCredentials" TEXT NOT NULL,
    "role" "network"."PanelRole" NOT NULL,
    "pairedPanelId" UUID,
    "status" "network"."PanelStatus" NOT NULL DEFAULT 'healthy',
    "region" TEXT NOT NULL,

    CONSTRAINT "panel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network"."config" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "panelId" UUID NOT NULL,
    "servicePlanId" UUID NOT NULL,
    "uuid" TEXT NOT NULL,
    "protocol" "network"."ConfigProtocol" NOT NULL,
    "status" "network"."ConfigStatus" NOT NULL DEFAULT 'active',
    "disabledReason" TEXT,
    "maxRegenerateCount" INTEGER NOT NULL DEFAULT 3,
    "regenerateUsedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network"."config_action_log" (
    "id" UUID NOT NULL,
    "configId" UUID NOT NULL,
    "actorType" "network"."ActorType" NOT NULL,
    "actorId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_action_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network"."traffic_raw_log" (
    "id" BIGSERIAL NOT NULL,
    "configId" UUID NOT NULL,
    "uploadBytes" BIGINT NOT NULL,
    "downloadBytes" BIGINT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traffic_raw_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network"."traffic_daily_aggregate" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "configId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "totalUploadBytes" BIGINT NOT NULL,
    "totalDownloadBytes" BIGINT NOT NULL,

    CONSTRAINT "traffic_daily_aggregate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network"."ip_access_rule" (
    "id" UUID NOT NULL,
    "ipAddressOrCidr" TEXT NOT NULL,
    "ruleType" "network"."IpRuleType" NOT NULL,
    "customLimitPerMinute" INTEGER,
    "reason" TEXT,
    "setByAdminId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_access_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification"."notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "notification"."NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification"."notification_campaign" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "createdByAdminId" UUID NOT NULL,
    "channel" "notification"."NotificationChannel" NOT NULL,
    "filterCriteria" JSONB NOT NULL,
    "messageBody" TEXT NOT NULL,
    "status" "notification"."CampaignStatus" NOT NULL DEFAULT 'draft',
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "executedByBotWorkerId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification"."notification_campaign_recipient" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deliveryStatus" "notification"."DeliveryStatus" NOT NULL DEFAULT 'queued',

    CONSTRAINT "notification_campaign_recipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."ticket" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "support"."TicketStatus" NOT NULL DEFAULT 'open',
    "priority" "support"."TicketPriority" NOT NULL DEFAULT 'medium',
    "assignedAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."ticket_message" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "senderType" "support"."SenderType" NOT NULL,
    "senderId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."ticket_attachment" (
    "id" UUID NOT NULL,
    "ticketMessageId" UUID NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,

    CONSTRAINT "ticket_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."chat_session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "assignedAdminId" UUID,
    "status" "support"."ChatSessionStatus" NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "chat_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."chat_message" (
    "id" UUID NOT NULL,
    "chatSessionId" UUID NOT NULL,
    "senderType" "support"."SenderType" NOT NULL,
    "senderId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant" (
    "id" UUID NOT NULL,
    "tenantType" "tenant"."TenantType" NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "tenant"."TenantStatus" NOT NULL DEFAULT 'trial',
    "billingModel" "tenant"."TenantBillingModel" NOT NULL,
    "suspendedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_branding" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "brandName" TEXT NOT NULL,
    "logoUrl" TEXT,
    "faviconUrl" TEXT,
    "primaryColorHex" TEXT,
    "secondaryColorHex" TEXT,
    "supportEmail" TEXT,
    "supportPhone" TEXT,
    "aboutText" TEXT,
    "termsUrl" TEXT,
    "privacyUrl" TEXT,
    "defaultLanguage" "identity"."Language" NOT NULL DEFAULT 'fa',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_branding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_domain" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "domainType" "tenant"."TenantDomainType" NOT NULL,
    "domainValue" TEXT NOT NULL,
    "verificationStatus" "tenant"."DomainVerificationStatus" NOT NULL DEFAULT 'pending',
    "verificationToken" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "arvanRegisteredAt" TIMESTAMP(3),

    CONSTRAINT "tenant_domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_feature_package" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyPrice" DECIMAL(18,2),
    "includedFeatureKeys" JSONB NOT NULL,
    "usageIncludedJson" JSONB NOT NULL,
    "overageRuleJson" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tenant_feature_package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_feature_entitlement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "featureKey" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "source" "tenant"."EntitlementSource" NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "tenant_feature_entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_staff_member" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleWithinTenant" "tenant"."TenantStaffRole" NOT NULL,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tenant_staff_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_billing_wallet" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "cachedBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tenant_billing_wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_billing_transaction" (
    "id" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "direction" "tenant"."TenantLedgerDirection" NOT NULL,
    "reasonType" "tenant"."TenantBillingReasonType" NOT NULL,
    "referenceId" UUID,
    "balanceAfter" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_billing_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_usage_meter" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "meterKey" "tenant"."TenantMeterKey" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(18,8) NOT NULL,
    "isBilled" BOOLEAN NOT NULL DEFAULT false,
    "billedTransactionId" UUID,

    CONSTRAINT "tenant_usage_meter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_gateway_config" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerName" "billing"."PaymentProviderName" NOT NULL,
    "gatewayCategory" "billing"."GatewayCategory" NOT NULL,
    "merchantIdEncrypted" TEXT,
    "apiKeyEncrypted" TEXT,
    "verificationStatus" "tenant"."TenantGatewayVerificationStatus" NOT NULL DEFAULT 'pending_test_transaction',
    "verifiedByAdminId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_gateway_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_sms_config" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "mode" "tenant"."TenantSmsMode" NOT NULL,
    "ownProviderName" TEXT,
    "ownApiKeyEncrypted" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tenant_sms_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_bot_integration" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "platform" "identity"."SocialPlatform" NOT NULL,
    "botTokenEncrypted" TEXT NOT NULL,
    "botUsername" TEXT NOT NULL,
    "webhookPath" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_bot_integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_restriction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "restrictionKey" TEXT NOT NULL,
    "limitValueJson" JSONB NOT NULL,
    "scope" "governance"."RestrictionScope" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tenant_restriction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_behavior_event_userId_idx" ON "ai"."user_behavior_event"("userId");

-- CreateIndex
CREATE INDEX "user_behavior_event_occurredAt_idx" ON "ai"."user_behavior_event"("occurredAt");

-- CreateIndex
CREATE INDEX "admin_audit_log_targetEntityId_createdAt_idx" ON "audit"."admin_audit_log"("targetEntityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "admin_audit_log_tenantId_idx" ON "audit"."admin_audit_log"("tenantId");

-- CreateIndex
CREATE INDEX "linked_account_member_groupId_idx" ON "audit"."linked_account_member"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "linked_account_member_scopeKey_userId_key" ON "audit"."linked_account_member"("scopeKey", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "bot_worker_key_key" ON "automation"."bot_worker"("key");

-- CreateIndex
CREATE INDEX "bot_execution_log_botWorkerId_startedAt_idx" ON "automation"."bot_execution_log"("botWorkerId", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_ownerUserId_key" ON "billing"."wallet"("ownerUserId");

-- CreateIndex
CREATE INDEX "wallet_transaction_walletId_createdAt_idx" ON "billing"."wallet_transaction"("walletId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "wallet_transaction_tenantId_idx" ON "billing"."wallet_transaction"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sub_account_configId_key" ON "billing"."sub_account"("configId");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_code_key" ON "billing"."coupon"("code");

-- CreateIndex
CREATE INDEX "coupon_allowed_user_couponId_userId_idx" ON "billing"."coupon_allowed_user"("couponId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_redemption_couponId_userId_key" ON "billing"."coupon_redemption"("couponId", "userId");

-- CreateIndex
CREATE INDEX "payment_transaction_tenantId_idx" ON "billing"."payment_transaction"("tenantId");

-- CreateIndex
CREATE INDEX "payment_transaction_status_expiresAt_idx" ON "billing"."payment_transaction"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "crypto_payment_detail_paymentTransactionId_key" ON "billing"."crypto_payment_detail"("paymentTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_commission_payoutWalletTransactionId_key" ON "billing"."affiliate_commission"("payoutWalletTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "product_category_key_key" ON "catalog"."product_category"("key");

-- CreateIndex
CREATE INDEX "product_category_tenantId_idx" ON "catalog"."product_category"("tenantId");

-- CreateIndex
CREATE INDEX "service_plan_tenantId_idx" ON "catalog"."service_plan"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "currency_code_key" ON "currency"."currency"("code");

-- CreateIndex
CREATE INDEX "currency_exchange_rate_currencyId_effectiveAt_idx" ON "currency"."currency_exchange_rate"("currencyId", "effectiveAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "user_currency_preference_userId_key" ON "currency"."user_currency_preference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "currency_policy_scope_userId_key" ON "currency"."currency_policy"("scope", "userId");

-- CreateIndex
CREATE INDEX "spin_wheel_config_tenantId_idx" ON "engagement"."spin_wheel_config"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "spin_wheel_attempt_resultWalletTransactionId_key" ON "engagement"."spin_wheel_attempt"("resultWalletTransactionId");

-- CreateIndex
CREATE INDEX "device_fingerprint_fingerprintHash_idx" ON "fraud"."device_fingerprint"("fingerprintHash");

-- CreateIndex
CREATE INDEX "fraud_flag_subjectType_subjectId_idx" ON "fraud"."fraud_flag"("subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "user_setting_userId_key_key" ON "governance"."user_setting"("userId", "key");

-- CreateIndex
CREATE INDEX "user_restriction_userId_idx" ON "governance"."user_restriction"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_restriction_userId_restrictionKey_key" ON "governance"."user_restriction"("userId", "restrictionKey");

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "identity"."user"("username");

-- CreateIndex
CREATE UNIQUE INDEX "user_phoneNumber_key" ON "identity"."user"("phoneNumber");

-- CreateIndex
CREATE INDEX "user_tenantId_idx" ON "identity"."user"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "session_refreshTokenHash_key" ON "identity"."session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "identity"."session"("userId");

-- CreateIndex
CREATE INDEX "session_userId_scopeKey_idx" ON "identity"."session"("userId", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "role_name_key" ON "identity"."role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permission_key_key" ON "identity"."permission"("key");

-- CreateIndex
CREATE INDEX "otp_code_phoneNumber_purpose_consumedAt_idx" ON "identity"."otp_code"("phoneNumber", "purpose", "consumedAt");

-- CreateIndex
CREATE UNIQUE INDEX "linked_bot_account_userId_platform_key" ON "identity"."linked_bot_account"("userId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "linked_bot_account_platform_platformUserId_key" ON "identity"."linked_bot_account"("platform", "platformUserId");

-- CreateIndex
CREATE INDEX "panel_tenantId_idx" ON "network"."panel"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "config_uuid_key" ON "network"."config"("uuid");

-- CreateIndex
CREATE INDEX "config_tenantId_createdAt_idx" ON "network"."config"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "config_userId_status_idx" ON "network"."config"("userId", "status");

-- CreateIndex
CREATE INDEX "traffic_raw_log_configId_recordedAt_idx" ON "network"."traffic_raw_log"("configId", "recordedAt");

-- CreateIndex
CREATE INDEX "traffic_daily_aggregate_userId_idx" ON "network"."traffic_daily_aggregate"("userId");

-- CreateIndex
CREATE INDEX "traffic_daily_aggregate_date_idx" ON "network"."traffic_daily_aggregate"("date");

-- CreateIndex
CREATE INDEX "ip_access_rule_ipAddressOrCidr_idx" ON "network"."ip_access_rule"("ipAddressOrCidr");

-- CreateIndex
CREATE INDEX "notification_userId_createdAt_idx" ON "notification"."notification"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "notification_campaign_tenantId_idx" ON "notification"."notification_campaign"("tenantId");

-- CreateIndex
CREATE INDEX "notification_campaign_recipient_campaignId_deliveryStatus_idx" ON "notification"."notification_campaign_recipient"("campaignId", "deliveryStatus");

-- CreateIndex
CREATE INDEX "chat_message_chatSessionId_sentAt_idx" ON "support"."chat_message"("chatSessionId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"."tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_branding_tenantId_key" ON "tenant"."tenant_branding"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_domain_domainValue_key" ON "tenant"."tenant_domain"("domainValue");

-- CreateIndex
CREATE INDEX "tenant_domain_tenantId_idx" ON "tenant"."tenant_domain"("tenantId");

-- CreateIndex
CREATE INDEX "tenant_feature_entitlement_tenantId_featureKey_idx" ON "tenant"."tenant_feature_entitlement"("tenantId", "featureKey");

-- CreateIndex
CREATE INDEX "tenant_staff_member_tenantId_idx" ON "tenant"."tenant_staff_member"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_billing_wallet_tenantId_key" ON "tenant"."tenant_billing_wallet"("tenantId");

-- CreateIndex
CREATE INDEX "tenant_billing_transaction_walletId_createdAt_idx" ON "tenant"."tenant_billing_transaction"("walletId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "tenant_usage_meter_tenantId_meterKey_periodStart_idx" ON "tenant"."tenant_usage_meter"("tenantId", "meterKey", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_gateway_config_tenantId_key" ON "tenant"."tenant_gateway_config"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_bot_integration_webhookPath_key" ON "tenant"."tenant_bot_integration"("webhookPath");

-- CreateIndex
CREATE INDEX "tenant_bot_integration_tenantId_idx" ON "tenant"."tenant_bot_integration"("tenantId");

-- CreateIndex
CREATE INDEX "tenant_restriction_tenantId_restrictionKey_idx" ON "tenant"."tenant_restriction"("tenantId", "restrictionKey");

-- AddForeignKey
ALTER TABLE "ai"."ai_guardrail_violation_log" ADD CONSTRAINT "ai_guardrail_violation_log_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "ai"."ai_recommendation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."ai_guardrail_violation_log" ADD CONSTRAINT "ai_guardrail_violation_log_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ai"."ai_guardrail_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit"."impersonation_session" ADD CONSTRAINT "impersonation_session_linkedTicketId_fkey" FOREIGN KEY ("linkedTicketId") REFERENCES "support"."ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit"."linked_account_member" ADD CONSTRAINT "linked_account_member_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "audit"."linked_account_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation"."bot_schedule" ADD CONSTRAINT "bot_schedule_botWorkerId_fkey" FOREIGN KEY ("botWorkerId") REFERENCES "automation"."bot_worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation"."bot_execution_log" ADD CONSTRAINT "bot_execution_log_botWorkerId_fkey" FOREIGN KEY ("botWorkerId") REFERENCES "automation"."bot_worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."wallet" ADD CONSTRAINT "wallet_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "identity"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."wallet_transaction" ADD CONSTRAINT "wallet_transaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "billing"."wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."sub_account" ADD CONSTRAINT "sub_account_parentWalletId_fkey" FOREIGN KEY ("parentWalletId") REFERENCES "billing"."wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."sub_account" ADD CONSTRAINT "sub_account_configId_fkey" FOREIGN KEY ("configId") REFERENCES "network"."config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."coupon_service_scope" ADD CONSTRAINT "coupon_service_scope_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "billing"."coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."coupon_service_scope" ADD CONSTRAINT "coupon_service_scope_servicePlanId_fkey" FOREIGN KEY ("servicePlanId") REFERENCES "catalog"."service_plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."coupon_service_scope" ADD CONSTRAINT "coupon_service_scope_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "catalog"."product_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."coupon_allowed_user" ADD CONSTRAINT "coupon_allowed_user_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "billing"."coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."coupon_redemption" ADD CONSTRAINT "coupon_redemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "billing"."coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."coupon_redemption" ADD CONSTRAINT "coupon_redemption_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "billing"."payment_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."payment_transaction" ADD CONSTRAINT "payment_transaction_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "billing"."payment_gateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."payment_reconciliation_log" ADD CONSTRAINT "payment_reconciliation_log_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "billing"."payment_transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."crypto_payment_detail" ADD CONSTRAINT "crypto_payment_detail_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "billing"."payment_transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."affiliate_commission" ADD CONSTRAINT "affiliate_commission_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "billing"."affiliate_referral"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."affiliate_commission" ADD CONSTRAINT "affiliate_commission_triggeringPaymentId_fkey" FOREIGN KEY ("triggeringPaymentId") REFERENCES "billing"."payment_transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."affiliate_commission" ADD CONSTRAINT "affiliate_commission_payoutWalletTransactionId_fkey" FOREIGN KEY ("payoutWalletTransactionId") REFERENCES "billing"."wallet_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog"."service_plan" ADD CONSTRAINT "service_plan_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "catalog"."product_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog"."service_plan_promotion" ADD CONSTRAINT "service_plan_promotion_servicePlanId_fkey" FOREIGN KEY ("servicePlanId") REFERENCES "catalog"."service_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "currency"."currency_exchange_rate" ADD CONSTRAINT "currency_exchange_rate_currencyId_fkey" FOREIGN KEY ("currencyId") REFERENCES "currency"."currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "currency"."user_currency_preference" ADD CONSTRAINT "user_currency_preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "identity"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "currency"."user_currency_preference" ADD CONSTRAINT "user_currency_preference_preferredCurrencyId_fkey" FOREIGN KEY ("preferredCurrencyId") REFERENCES "currency"."currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "currency"."currency_policy" ADD CONSTRAINT "currency_policy_enforcedCurrencyId_fkey" FOREIGN KEY ("enforcedCurrencyId") REFERENCES "currency"."currency"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement"."spin_wheel_prize" ADD CONSTRAINT "spin_wheel_prize_wheelConfigId_fkey" FOREIGN KEY ("wheelConfigId") REFERENCES "engagement"."spin_wheel_config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement"."spin_wheel_attempt" ADD CONSTRAINT "spin_wheel_attempt_deviceFingerprintId_fkey" FOREIGN KEY ("deviceFingerprintId") REFERENCES "fraud"."device_fingerprint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement"."spin_wheel_attempt" ADD CONSTRAINT "spin_wheel_attempt_prizeAwardedId_fkey" FOREIGN KEY ("prizeAwardedId") REFERENCES "engagement"."spin_wheel_prize"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement"."spin_wheel_attempt" ADD CONSTRAINT "spin_wheel_attempt_resultWalletTransactionId_fkey" FOREIGN KEY ("resultWalletTransactionId") REFERENCES "billing"."wallet_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud"."device_fingerprint" ADD CONSTRAINT "device_fingerprint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "identity"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."user" ADD CONSTRAINT "user_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."user" ADD CONSTRAINT "user_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "identity"."role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."user" ADD CONSTRAINT "user_referredByUserId_fkey" FOREIGN KEY ("referredByUserId") REFERENCES "identity"."user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "identity"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."session" ADD CONSTRAINT "session_switchedFromUserId_fkey" FOREIGN KEY ("switchedFromUserId") REFERENCES "identity"."user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."session" ADD CONSTRAINT "session_impersonationSessionId_fkey" FOREIGN KEY ("impersonationSessionId") REFERENCES "audit"."impersonation_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."role_permission" ADD CONSTRAINT "role_permission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "identity"."role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."role_permission" ADD CONSTRAINT "role_permission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "identity"."permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."otp_code" ADD CONSTRAINT "otp_code_userId_fkey" FOREIGN KEY ("userId") REFERENCES "identity"."user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."linked_bot_account" ADD CONSTRAINT "linked_bot_account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "identity"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network"."panel" ADD CONSTRAINT "panel_pairedPanelId_fkey" FOREIGN KEY ("pairedPanelId") REFERENCES "network"."panel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network"."config" ADD CONSTRAINT "config_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "network"."panel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network"."config" ADD CONSTRAINT "config_servicePlanId_fkey" FOREIGN KEY ("servicePlanId") REFERENCES "catalog"."service_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network"."config_action_log" ADD CONSTRAINT "config_action_log_configId_fkey" FOREIGN KEY ("configId") REFERENCES "network"."config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network"."traffic_raw_log" ADD CONSTRAINT "traffic_raw_log_configId_fkey" FOREIGN KEY ("configId") REFERENCES "network"."config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network"."traffic_daily_aggregate" ADD CONSTRAINT "traffic_daily_aggregate_configId_fkey" FOREIGN KEY ("configId") REFERENCES "network"."config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification"."notification_campaign_recipient" ADD CONSTRAINT "notification_campaign_recipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "notification"."notification_campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."ticket_message" ADD CONSTRAINT "ticket_message_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support"."ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."ticket_attachment" ADD CONSTRAINT "ticket_attachment_ticketMessageId_fkey" FOREIGN KEY ("ticketMessageId") REFERENCES "support"."ticket_message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."chat_message" ADD CONSTRAINT "chat_message_chatSessionId_fkey" FOREIGN KEY ("chatSessionId") REFERENCES "support"."chat_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_branding" ADD CONSTRAINT "tenant_branding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_domain" ADD CONSTRAINT "tenant_domain_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_feature_entitlement" ADD CONSTRAINT "tenant_feature_entitlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_staff_member" ADD CONSTRAINT "tenant_staff_member_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_billing_wallet" ADD CONSTRAINT "tenant_billing_wallet_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_billing_transaction" ADD CONSTRAINT "tenant_billing_transaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "tenant"."tenant_billing_wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_usage_meter" ADD CONSTRAINT "tenant_usage_meter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_usage_meter" ADD CONSTRAINT "tenant_usage_meter_billedTransactionId_fkey" FOREIGN KEY ("billedTransactionId") REFERENCES "tenant"."tenant_billing_transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_gateway_config" ADD CONSTRAINT "tenant_gateway_config_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_sms_config" ADD CONSTRAINT "tenant_sms_config_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_bot_integration" ADD CONSTRAINT "tenant_bot_integration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_restriction" ADD CONSTRAINT "tenant_restriction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

