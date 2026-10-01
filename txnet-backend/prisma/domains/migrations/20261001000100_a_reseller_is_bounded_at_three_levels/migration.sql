-- F-019-m (ADR-0106, user 2026-10-01): a reseller is bounded by limits set at
-- three levels, the most specific winning — its own, its package's, the
-- platform's (else the code default). A value of NULL is "no limit", on
-- purpose; no row is "not set at this level".
--
--   reseller_limit_setting — the platform's, one row per key; no tenant, no RLS
--                            (as tenant_feature_package).
--   package_limit          — a package's, one row per (package, key).
--   reseller_limit         — one reseller's, with a reason; strict tenant RLS,
--                            as tenant_subscription, so a service reads it in
--                            the reseller's own scope.
--
-- Keys are checked in code (`RESELLER_LIMITS`); here only their shape.
-- tenant_restriction is left alone (read by no code; removal is F-019-u).
--
-- Additive; rollback: DROP TABLE "tenant"."reseller_limit",
-- "tenant"."package_limit", "tenant"."reseller_limit_setting".

ALTER TYPE "audit"."AdminAction" ADD VALUE 'reseller_limit_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'reseller_limit_clear';

CREATE TABLE "tenant"."reseller_limit_setting" (
    "key" TEXT NOT NULL,
    "value" INTEGER,
    "updatedByUserId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reseller_limit_setting_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "reseller_limit_setting_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,63}$'),
    CONSTRAINT "reseller_limit_setting_value_not_negative" CHECK ("value" IS NULL OR "value" >= 0)
);

CREATE TABLE "tenant"."package_limit" (
    "packageId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER,
    "updatedByUserId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "package_limit_pkey" PRIMARY KEY ("packageId", "key"),
    CONSTRAINT "package_limit_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,63}$'),
    CONSTRAINT "package_limit_value_not_negative" CHECK ("value" IS NULL OR "value" >= 0)
);

ALTER TABLE "tenant"."package_limit" ADD CONSTRAINT "package_limit_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "tenant"."tenant_feature_package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "tenant"."reseller_limit" (
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER,
    "reason" TEXT NOT NULL,
    "setByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reseller_limit_pkey" PRIMARY KEY ("tenantId", "key"),
    CONSTRAINT "reseller_limit_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,63}$'),
    CONSTRAINT "reseller_limit_value_not_negative" CHECK ("value" IS NULL OR "value" >= 0),
    CONSTRAINT "reseller_limit_reason_present" CHECK (length(btrim("reason")) > 0)
);

ALTER TABLE "tenant"."reseller_limit" ADD CONSTRAINT "reseller_limit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE tenant.reseller_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.reseller_limit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.reseller_limit
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON tenant.reseller_limit
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
