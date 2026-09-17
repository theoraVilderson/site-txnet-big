-- F-018-e — a reseller's subscription, and the platform's trial length.
--
-- 1. `tenant_subscription`: one row per tenant (the primary key), the package
--    it is on and `currentPeriodEnd`, which F-019-c renews. The period itself
--    is `tenant.billingModel`. A package with subscribers cannot be deleted
--    (RESTRICT) — packages are never deleted anyway (F-018-d).
-- 2. Strict RLS on it, the same shape as every tenant-owned table (section 99,
--    list A): a reseller reads its own row, the cross-tenant pool reads all.
-- 3. `tenant_subscription_setting`: the platform's one row (`id = 1`), with
--    `trialDays` in 0..365. No `tenantId`, no RLS — it is the platform's.
-- 4. Audit values for putting a tenant on a package and editing the setting.
--
-- Rollback: drop both tables. The audit enum values stay, unused (Postgres
-- cannot drop an enum value).

CREATE TABLE "tenant"."tenant_subscription" (
    "tenantId" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_subscription_pkey" PRIMARY KEY ("tenantId")
);

CREATE INDEX "tenant_subscription_packageId_idx" ON "tenant"."tenant_subscription"("packageId");
CREATE INDEX "tenant_subscription_currentPeriodEnd_idx" ON "tenant"."tenant_subscription"("currentPeriodEnd");

ALTER TABLE "tenant"."tenant_subscription" ADD CONSTRAINT "tenant_subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant"."tenant_subscription" ADD CONSTRAINT "tenant_subscription_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "tenant"."tenant_feature_package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE tenant.tenant_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.tenant_subscription FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.tenant_subscription
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON tenant.tenant_subscription
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

CREATE TABLE "tenant"."tenant_subscription_setting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "trialDays" INTEGER NOT NULL DEFAULT 14,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_subscription_setting_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_subscription_setting_single_row" CHECK ("id" = 1),
    CONSTRAINT "tenant_subscription_setting_trial_days_range" CHECK ("trialDays" BETWEEN 0 AND 365)
);

INSERT INTO "tenant"."tenant_subscription_setting" ("id", "trialDays", "updatedAt")
VALUES (1, 14, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'tenant_subscription_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'tenant_subscription_setting_update';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'tenant_subscription_setting';
