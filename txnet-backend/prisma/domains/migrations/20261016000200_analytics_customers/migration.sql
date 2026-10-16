-- F-1001-f: the Customers tab — renewal, signups, and the tenant's renewal
-- window (billing/contract.analytics.md "Renewal"). Additive: four tables
-- and an enum.

CREATE TYPE "billing"."AnalyticsRenewalState" AS ENUM ('renewed', 'lapsed', 'pending');

-- One ended term of a Grant. Derived by the rollup, like every analytics table.
CREATE TABLE "billing"."analytics_grant_end" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "productId" UUID,
    "panelId" UUID,
    "endedOn" DATE NOT NULL,
    "renewedOn" DATE,
    "state" "billing"."AnalyticsRenewalState" NOT NULL,

    CONSTRAINT "analytics_grant_end_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "analytics_grant_end_grantId_endedOn_key" ON "billing"."analytics_grant_end"("grantId", "endedOn");
CREATE INDEX "analytics_grant_end_tenantId_endedOn_idx" ON "billing"."analytics_grant_end"("tenantId", "endedOn");

-- One row per user who signed up, written by identity's event.
CREATE TABLE "billing"."analytics_signup" (
    "userId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "signedUpAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "analytics_signup_pkey" PRIMARY KEY ("userId")
);
CREATE INDEX "analytics_signup_tenantId_signedUpAt_idx" ON "billing"."analytics_signup"("tenantId", "signedUpAt");

-- A flow: signups per tenant day and source, and how many bought within 7 and 30 days.
CREATE TABLE "billing"."analytics_signup_day" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "signups" INTEGER NOT NULL,
    "purchased7" INTEGER NOT NULL,
    "purchased30" INTEGER NOT NULL,

    CONSTRAINT "analytics_signup_day_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "analytics_signup_day_tenantId_day_source_key" ON "billing"."analytics_signup_day"("tenantId", "day", "source");

-- A tenant's settings; none = the defaults in code (7 days).
CREATE TABLE "billing"."analytics_setting" (
    "tenantId" UUID NOT NULL,
    "renewalWindowDays" INTEGER NOT NULL,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analytics_setting_pkey" PRIMARY KEY ("tenantId"),
    CONSTRAINT "analytics_setting_renewal_window" CHECK ("renewalWindowDays" BETWEEN 1 AND 30)
);

-- Strict shape, as `20261015001300_analytics_rollup`.
ALTER TABLE "billing"."analytics_grant_end" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing"."analytics_grant_end" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing"."analytics_grant_end"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "billing"."analytics_grant_end"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."analytics_grant_end" TO txnet_app, txnet_cross_tenant;

ALTER TABLE "billing"."analytics_signup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing"."analytics_signup" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing"."analytics_signup"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "billing"."analytics_signup"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."analytics_signup" TO txnet_app, txnet_cross_tenant;

ALTER TABLE "billing"."analytics_signup_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing"."analytics_signup_day" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing"."analytics_signup_day"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "billing"."analytics_signup_day"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."analytics_signup_day" TO txnet_app, txnet_cross_tenant;

ALTER TABLE "billing"."analytics_setting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing"."analytics_setting" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing"."analytics_setting"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "billing"."analytics_setting"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."analytics_setting" TO txnet_app, txnet_cross_tenant;

-- The users who signed up before the event existed, once: their source was
-- never recorded, so it is `unknown`. Every later one arrives by the event.
INSERT INTO "billing"."analytics_signup" ("userId", "tenantId", "signedUpAt", "source")
SELECT u."id", u."tenantId", u."createdAt", 'unknown' FROM "identity"."user" u
ON CONFLICT DO NOTHING;

-- Every tenant is rebuilt whole by the next tick (as `20261016000100`).
UPDATE "billing"."analytics_rollup_state" SET "rebuildingSince" = now();
