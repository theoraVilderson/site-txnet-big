-- F-038-a (ADR-0109 point 5, user 2026-10-02): the `ai` schema rebuilt.
--
-- The onboarding tables carried no `tenantId` and VPN-shaped enums; no code
-- read them and all four were empty on dev (0 rows each, 2026-10-02). They are
-- dropped, not migrated. The new tables are each one tenant's, strict RLS from
-- this migration on (shape A of 20260909001500), so `ai-service` reading on
-- the app pool sees one tenant's accounts and never another's.
--
-- A reseller as a subject (point 4) is a row in the platform's tenant with
-- `subjectKind = tenant`, `subjectId` = the reseller's tenant id.
--
-- `engagement.attention_budget` (F-1501, C-13) is a count of proactive
-- messages per subject — never a ledger account.
--
-- Rollback: DROP the eleven `ai` tables and `engagement.attention_budget`, the
-- seven `Ai*` types; the old tables are in 20260908000000_init.

-- CreateEnum
CREATE TYPE "ai"."AiSubjectKind" AS ENUM ('user', 'tenant');

-- CreateEnum
CREATE TYPE "ai"."AiActionType" AS ENUM ('renew', 'resize_up', 'resize_down', 'top_up_wallet', 'retain_offer', 'trial_convert', 'checkout_help', 'win_back', 'usage_alert', 'cross_sell', 'wheel_invite', 'referral_invite');

-- CreateEnum
CREATE TYPE "ai"."AiPredictionKind" AS ENUM ('meter_exhaustion', 'renewal_probability', 'right_size', 'wallet_need', 'active_hours', 'trial_conversion', 'win_back_window', 'quota_exhaustion', 'churn_risk');

-- CreateEnum
CREATE TYPE "ai"."AiActionStatus" AS ENUM ('suppressed', 'awaiting_approval', 'scheduled', 'sent', 'accepted', 'dismissed', 'expired');

-- CreateEnum
CREATE TYPE "ai"."AiRenderedBy" AS ENUM ('template', 'model');

-- CreateEnum
CREATE TYPE "ai"."AiProviderOwnership" AS ENUM ('tenant', 'platform');

-- CreateEnum
CREATE TYPE "ai"."AiProviderStatus" AS ENUM ('untested', 'ok', 'failing');

-- DropForeignKey
ALTER TABLE "ai"."ai_guardrail_violation_log" DROP CONSTRAINT "ai_guardrail_violation_log_recommendationId_fkey";

-- DropForeignKey
ALTER TABLE "ai"."ai_guardrail_violation_log" DROP CONSTRAINT "ai_guardrail_violation_log_ruleId_fkey";

-- DropTable
DROP TABLE "ai"."ai_guardrail_rule";

-- DropTable
DROP TABLE "ai"."ai_guardrail_violation_log";

-- DropTable
DROP TABLE "ai"."ai_recommendation";

-- DropTable
DROP TABLE "ai"."user_behavior_event";

-- DropEnum
DROP TYPE "ai"."BehaviorEventType";

-- DropEnum
DROP TYPE "ai"."GuardrailAction";

-- DropEnum
DROP TYPE "ai"."GuardrailRuleType";

-- DropEnum
DROP TYPE "ai"."RecommendationStatus";

-- DropEnum
DROP TYPE "ai"."RecommendationType";

-- CreateTable
CREATE TABLE "ai"."account_profile" (
    "tenantId" UUID NOT NULL,
    "subjectKind" "ai"."AiSubjectKind" NOT NULL,
    "subjectId" UUID NOT NULL,
    "features" JSONB NOT NULL,
    "activeHours" DOUBLE PRECISION[],
    "builtAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_profile_pkey" PRIMARY KEY ("tenantId","subjectKind","subjectId")
);

-- CreateTable
CREATE TABLE "ai"."prediction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "subjectKind" "ai"."AiSubjectKind" NOT NULL,
    "subjectId" UUID NOT NULL,
    "kind" "ai"."AiPredictionKind" NOT NULL,
    "value" DECIMAL(18,4),
    "predictedAt" TIMESTAMP(3),
    "confidence" DECIMAL(5,4) NOT NULL,
    "reasons" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."action" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "subjectKind" "ai"."AiSubjectKind" NOT NULL,
    "subjectId" UUID NOT NULL,
    "actionType" "ai"."AiActionType" NOT NULL,
    "status" "ai"."AiActionStatus" NOT NULL,
    "suppressedBy" TEXT,
    "confidence" DECIMAL(5,4) NOT NULL,
    "reasons" JSONB NOT NULL,
    "predictionId" UUID,
    "offerId" UUID,
    "templateKey" TEXT NOT NULL,
    "renderedBy" "ai"."AiRenderedBy" NOT NULL DEFAULT 'template',
    "renderedText" TEXT,
    "expectedMargin" DECIMAL(18,2),
    "expectedMarginCurrency" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "deadline" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "outcomeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."offer" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "actionType" "ai"."AiActionType" NOT NULL,
    "couponTemplateId" UUID,
    "variantId" UUID,
    "maxDiscountPercent" DECIMAL(5,2) NOT NULL,
    "dailyBudget" DECIMAL(18,2) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."guardrail" (
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" DECIMAL(18,4) NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guardrail_pkey" PRIMARY KEY ("tenantId","key")
);

-- CreateTable
CREATE TABLE "ai"."holdout" (
    "tenantId" UUID NOT NULL,
    "subjectKind" "ai"."AiSubjectKind" NOT NULL,
    "subjectId" UUID NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holdout_pkey" PRIMARY KEY ("tenantId","subjectKind","subjectId")
);

-- CreateTable
CREATE TABLE "ai"."opt_out" (
    "tenantId" UUID NOT NULL,
    "subjectKind" "ai"."AiSubjectKind" NOT NULL,
    "subjectId" UUID NOT NULL,
    "actionType" "ai"."AiActionType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opt_out_pkey" PRIMARY KEY ("tenantId","subjectKind","subjectId","actionType")
);

-- CreateTable
CREATE TABLE "ai"."provider" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "ownershipType" "ai"."AiProviderOwnership" NOT NULL,
    "name" TEXT NOT NULL,
    "driver" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "keyFingerprint" TEXT,
    "proxyUrl" TEXT,
    "status" "ai"."AiProviderStatus" NOT NULL DEFAULT 'untested',
    "lastErrorAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai"."task_route" (
    "tenantId" UUID NOT NULL,
    "task" TEXT NOT NULL,
    "providerId" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_route_pkey" PRIMARY KEY ("tenantId","task")
);

-- CreateTable
CREATE TABLE "ai"."usage" (
    "tenantId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "task" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" BIGINT NOT NULL DEFAULT 0,
    "completionTokens" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "usage_pkey" PRIMARY KEY ("tenantId","providerId","task","day")
);

-- CreateTable
CREATE TABLE "ai"."setting" (
    "tenantId" UUID NOT NULL,
    "engineEnabled" BOOLEAN NOT NULL DEFAULT true,
    "disabledActionTypes" "ai"."AiActionType"[] DEFAULT ARRAY[]::"ai"."AiActionType"[],
    "automaticActionTypes" "ai"."AiActionType"[] DEFAULT ARRAY[]::"ai"."AiActionType"[],
    "confidenceThreshold" DECIMAL(3,2) NOT NULL DEFAULT 0.6,
    "holdoutPercent" INTEGER NOT NULL DEFAULT 10,
    "piiScrubEnabled" BOOLEAN NOT NULL DEFAULT true,
    "modelTimeBudgetMs" INTEGER NOT NULL DEFAULT 3000,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "setting_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "engagement"."attention_budget" (
    "tenantId" UUID NOT NULL,
    "subjectKind" "ai"."AiSubjectKind" NOT NULL,
    "subjectId" UUID NOT NULL,
    "chargedAt" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attention_budget_pkey" PRIMARY KEY ("tenantId","subjectKind","subjectId")
);

-- CreateIndex
CREATE INDEX "prediction_tenantId_subjectKind_subjectId_kind_computedAt_idx" ON "ai"."prediction"("tenantId", "subjectKind", "subjectId", "kind", "computedAt");

-- CreateIndex
CREATE INDEX "action_tenantId_subjectKind_subjectId_actionType_createdAt_idx" ON "ai"."action"("tenantId", "subjectKind", "subjectId", "actionType", "createdAt");

-- CreateIndex
CREATE INDEX "action_tenantId_status_scheduledFor_idx" ON "ai"."action"("tenantId", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "offer_tenantId_actionType_idx" ON "ai"."offer"("tenantId", "actionType");

-- CreateIndex
CREATE INDEX "provider_tenantId_idx" ON "ai"."provider"("tenantId");

-- AddForeignKey
ALTER TABLE "ai"."action" ADD CONSTRAINT "action_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "ai"."offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."task_route" ADD CONSTRAINT "task_route_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ai"."provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai"."usage" ADD CONSTRAINT "usage_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ai"."provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECKs Prisma cannot express ---------------------------------------------

ALTER TABLE "ai"."prediction" ADD CONSTRAINT "prediction_confidence_range" CHECK ("confidence" BETWEEN 0 AND 1);
ALTER TABLE "ai"."prediction" ADD CONSTRAINT "prediction_reasons_present" CHECK (jsonb_typeof("reasons") = 'array' AND jsonb_array_length("reasons") > 0);
ALTER TABLE "ai"."action" ADD CONSTRAINT "action_confidence_range" CHECK ("confidence" BETWEEN 0 AND 1);
ALTER TABLE "ai"."action" ADD CONSTRAINT "action_reasons_present" CHECK (jsonb_typeof("reasons") = 'array' AND jsonb_array_length("reasons") > 0);
ALTER TABLE "ai"."action" ADD CONSTRAINT "action_suppressed_says_by_what" CHECK (("status" = 'suppressed') = ("suppressedBy" IS NOT NULL));
ALTER TABLE "ai"."action" ADD CONSTRAINT "action_margin_has_currency" CHECK (("expectedMargin" IS NULL) = ("expectedMarginCurrency" IS NULL));
ALTER TABLE "ai"."offer" ADD CONSTRAINT "offer_one_target" CHECK (num_nonnulls("couponTemplateId", "variantId") = 1);
ALTER TABLE "ai"."offer" ADD CONSTRAINT "offer_discount_range" CHECK ("maxDiscountPercent" > 0 AND "maxDiscountPercent" <= 100);
ALTER TABLE "ai"."offer" ADD CONSTRAINT "offer_budget_not_negative" CHECK ("dailyBudget" >= 0);
ALTER TABLE "ai"."guardrail" ADD CONSTRAINT "guardrail_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE "ai"."guardrail" ADD CONSTRAINT "guardrail_value_not_negative" CHECK ("value" >= 0);
ALTER TABLE "ai"."usage" ADD CONSTRAINT "usage_counts_not_negative" CHECK ("calls" >= 0 AND "promptTokens" >= 0 AND "completionTokens" >= 0);
ALTER TABLE "ai"."setting" ADD CONSTRAINT "setting_threshold_range" CHECK ("confidenceThreshold" BETWEEN 0 AND 1);
ALTER TABLE "ai"."setting" ADD CONSTRAINT "setting_holdout_range" CHECK ("holdoutPercent" BETWEEN 5 AND 20);
ALTER TABLE "ai"."setting" ADD CONSTRAINT "setting_time_budget_positive" CHECK ("modelTimeBudgetMs" > 0);
ALTER TABLE "ai"."account_profile" ADD CONSTRAINT "account_profile_168_hours" CHECK ("activeHours" IS NULL OR cardinality("activeHours") IN (0, 168));

-- Row-Level Security: strict, every table --------------------------------

ALTER TABLE ai.account_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.account_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.account_profile
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON ai.account_profile
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

ALTER TABLE ai.prediction ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.prediction FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.prediction
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON ai.prediction
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

ALTER TABLE ai.action ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.action FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.action
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON ai.action
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

ALTER TABLE ai.offer ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.offer FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.offer
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON ai.offer
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

ALTER TABLE ai.guardrail ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.guardrail FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.guardrail
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON ai.guardrail
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

ALTER TABLE ai.holdout ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.holdout FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.holdout
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON ai.holdout
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

ALTER TABLE ai.opt_out ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.opt_out FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.opt_out
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON ai.opt_out
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

ALTER TABLE ai.provider ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.provider FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.provider
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON ai.provider
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

ALTER TABLE ai.task_route ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.task_route FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.task_route
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON ai.task_route
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

ALTER TABLE ai.usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.usage
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON ai.usage
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

ALTER TABLE ai.setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.setting FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.setting
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON ai.setting
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

ALTER TABLE engagement.attention_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.attention_budget FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON engagement.attention_budget
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON engagement.attention_budget
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
