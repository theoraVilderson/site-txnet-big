-- F-030-d (§3.9): a cap or a bar on one person, set, changed and lifted by
-- staff with `restriction.assign`. The draft `governance.user_restriction`
-- had no tenant, no RLS, a `scope` and an `isActive` no rule needed; it is
-- rebuilt as one row per person and key on the person's tenant, strict RLS
-- (shape A, as `identity.user_permission`). Which keys exist and what each
-- value is lives in code (`USER_RESTRICTIONS`, shared-core).
--
-- Destructive (DROP TABLE, DROP TYPE): read or written by no code since the
-- first draft; 0 rows on dev, 2026-10-13; the rebuild was asked and approved
-- (user, 2026-10-13). Rollback: drop the new table and recreate the old one
-- and its enum from 20260908000000_init.

-- AlterEnum
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'user_restriction_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'user_restriction_lift';

DROP TABLE "governance"."user_restriction"; -- contract: F-030-d

DROP TYPE "governance"."RestrictionScope"; -- contract: F-030-d

-- CreateTable
CREATE TABLE "governance"."user_restriction" (
    "userId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "value" JSONB NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "setByUserId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_restriction_pkey" PRIMARY KEY ("userId","key")
);

-- CreateIndex
CREATE INDEX "user_restriction_tenantId_idx" ON "governance"."user_restriction"("tenantId");

ALTER TABLE "governance"."user_restriction" ADD CONSTRAINT "user_restriction_reason_ok" CHECK (length(btrim("reason")) > 0);

-- Strict shape (`20260909001500_row_level_security_all_tables`, shape A).
ALTER TABLE governance.user_restriction ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance.user_restriction FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON governance.user_restriction;
CREATE POLICY tenant_isolation ON governance.user_restriction
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

DROP POLICY IF EXISTS cross_tenant ON governance.user_restriction;
CREATE POLICY cross_tenant ON governance.user_restriction
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON governance.user_restriction TO txnet_app, txnet_cross_tenant;
