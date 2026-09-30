-- F-118-ao (user 2026-09-30): a metered Grant costs nothing at the sale, so a
-- user could buy a hundred and hold a panel seat for each. A user now holds at
-- most N open (`pending`, `active`, `suspended`) metered Grants: the platform's
-- default 5 (in code), a tenant's own default, or one user's own number, set
-- by staff when the user asks in a ticket.
--
--   grant_limit_setting — one row per tenant; none = the platform's default.
--   user_grant_limit    — one row per (tenant, user); replaces the default.
--
-- Neither is history: a number is changed in place. Strict tenant RLS, as
-- every entitlement table. No foreign keys, as the schema declares no relation:
-- the user is identity's, and the actor may be the platform's staff.
--
-- Additive; rollback: DROP TABLE "entitlement"."user_grant_limit",
-- "entitlement"."grant_limit_setting".

CREATE TABLE "entitlement"."grant_limit_setting" (
    "tenantId" UUID NOT NULL,
    "meteredOpenCap" INTEGER NOT NULL,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grant_limit_setting_pkey" PRIMARY KEY ("tenantId"),
    CONSTRAINT "grant_limit_setting_cap_not_negative" CHECK ("meteredOpenCap" >= 0)
);

CREATE TABLE "entitlement"."user_grant_limit" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "meteredOpenCap" INTEGER NOT NULL,
    "reason" TEXT,
    "setByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_grant_limit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_grant_limit_cap_not_negative" CHECK ("meteredOpenCap" >= 0)
);

CREATE UNIQUE INDEX "user_grant_limit_tenantId_userId_key" ON "entitlement"."user_grant_limit"("tenantId", "userId");


ALTER TABLE entitlement.grant_limit_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.grant_limit_setting FORCE ROW LEVEL SECURITY;
ALTER TABLE entitlement.user_grant_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.user_grant_limit FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement"."grant_limit_setting", "entitlement"."user_grant_limit" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "entitlement"."grant_limit_setting"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "entitlement"."grant_limit_setting"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

CREATE POLICY tenant_isolation ON "entitlement"."user_grant_limit"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "entitlement"."user_grant_limit"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
