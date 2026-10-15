-- F-0401-b — a tenant's freeze switches (entitlement `contract.admin.md`
-- "Freeze settings"): whether its users may freeze their own metered Grant
-- (default on), and whether that freeze stops the clock (default no).
--
--   grant_freeze_setting — one row per tenant; none = the platform's defaults
--                          (in code). Changed in place, not history: every
--                          change is audited `grant_freeze_settings_set`.
--
-- Strict tenant RLS, as every entitlement table; no foreign keys, as the
-- schema declares no relation. Additive; rollback: drop the table (the enum
-- value stays: Postgres cannot remove one).

ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_freeze_settings_set';

CREATE TABLE "entitlement"."grant_freeze_setting" (
    "tenantId" UUID NOT NULL,
    "selfFreezeEnabled" BOOLEAN NOT NULL,
    "selfFreezeStopsClock" BOOLEAN NOT NULL,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grant_freeze_setting_pkey" PRIMARY KEY ("tenantId")
);

ALTER TABLE entitlement.grant_freeze_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.grant_freeze_setting FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement"."grant_freeze_setting" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "entitlement"."grant_freeze_setting"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "entitlement"."grant_freeze_setting"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
