-- The onboarding checklist gains an optional first step, "bring my users"
-- (F-213): done by a committed panel or link import, or by the reseller saying
-- it has none to bring. That "none" is a person's decision, not a count of
-- live rows, so it is the one onboarding fact that is stored.
--
-- `tenant.tenant_onboarding_skip` holds one row per skipped optional step
-- (user, 2026-10-22: one small table, so the next optional step needs no new
-- column). Deleting the row undoes the skip.
--
-- Additive only: a new enum and a new table. Rollback: drop both.

-- CreateEnum
CREATE TYPE "tenant"."TenantOnboardingOptionalStep" AS ENUM ('import');

-- CreateTable
CREATE TABLE "tenant"."tenant_onboarding_skip" (
    "tenantId" UUID NOT NULL,
    "step" "tenant"."TenantOnboardingOptionalStep" NOT NULL,
    "skippedByUserId" UUID NOT NULL,
    "skippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_onboarding_skip_pkey" PRIMARY KEY ("tenantId","step")
);

-- AddForeignKey
ALTER TABLE "tenant"."tenant_onboarding_skip" ADD CONSTRAINT "tenant_onboarding_skip_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant data: strict, as every tenant-owned table (shape A). The checklist
-- reads it on the cross-tenant pool; the skip writes in the tenant's scope.
ALTER TABLE "tenant"."tenant_onboarding_skip" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant"."tenant_onboarding_skip" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant"."tenant_onboarding_skip" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "tenant"."tenant_onboarding_skip"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "tenant"."tenant_onboarding_skip"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
