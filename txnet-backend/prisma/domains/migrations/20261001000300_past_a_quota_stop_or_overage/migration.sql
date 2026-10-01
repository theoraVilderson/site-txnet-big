-- F-019-v1 (ADR-0107 points 1, 2, user 2026-10-01): past a quota key's number
-- a reseller is refused (`stop`) or sold each further unit from its billing
-- wallet (`overage`, at a unit price in the platform's currency). Set at the
-- same three levels as the number, the most specific winning; the code
-- default is `stop`. Whether a key is a quota or a guard is the registry's
-- (`RESELLER_LIMITS[key].kind`), checked in code; here only the shape.
--
-- Kept apart from reseller_limit_setting / package_limit / reseller_limit:
-- a row there is that level's number, and "no row" means "not set here". A
-- mode stored on the same row would make every number override reset the
-- mode, or every mode override pin the number.
--
--   quota_overage_setting  — the platform's, one row per key; no tenant, no RLS.
--   package_quota_overage  — a package's, one row per (package, key).
--   reseller_quota_overage — one reseller's, with a reason; strict tenant RLS.
--
-- Additive; rollback: DROP TABLE "tenant"."reseller_quota_overage",
-- "tenant"."package_quota_overage", "tenant"."quota_overage_setting";
-- DROP TYPE "tenant"."QuotaOverageMode".

ALTER TYPE "audit"."AdminAction" ADD VALUE 'reseller_overage_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'reseller_overage_clear';

CREATE TYPE "tenant"."QuotaOverageMode" AS ENUM ('stop', 'overage');

CREATE TABLE "tenant"."quota_overage_setting" (
    "key" TEXT NOT NULL,
    "mode" "tenant"."QuotaOverageMode" NOT NULL,
    "unitPrice" DECIMAL(18,2),
    "currencyCode" TEXT,
    "updatedByUserId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quota_overage_setting_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "quota_overage_setting_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,63}$'),
    CONSTRAINT "quota_overage_setting_priced_iff_overage" CHECK (
        ("mode" = 'stop' AND "unitPrice" IS NULL AND "currencyCode" IS NULL)
     OR ("mode" = 'overage' AND "unitPrice" > 0 AND "currencyCode" ~ '^[A-Z]{3}$'))
);

CREATE TABLE "tenant"."package_quota_overage" (
    "packageId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "mode" "tenant"."QuotaOverageMode" NOT NULL,
    "unitPrice" DECIMAL(18,2),
    "currencyCode" TEXT,
    "updatedByUserId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "package_quota_overage_pkey" PRIMARY KEY ("packageId", "key"),
    CONSTRAINT "package_quota_overage_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,63}$'),
    CONSTRAINT "package_quota_overage_priced_iff_overage" CHECK (
        ("mode" = 'stop' AND "unitPrice" IS NULL AND "currencyCode" IS NULL)
     OR ("mode" = 'overage' AND "unitPrice" > 0 AND "currencyCode" ~ '^[A-Z]{3}$'))
);

ALTER TABLE "tenant"."package_quota_overage" ADD CONSTRAINT "package_quota_overage_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "tenant"."tenant_feature_package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "tenant"."reseller_quota_overage" (
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "mode" "tenant"."QuotaOverageMode" NOT NULL,
    "unitPrice" DECIMAL(18,2),
    "currencyCode" TEXT,
    "reason" TEXT NOT NULL,
    "setByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reseller_quota_overage_pkey" PRIMARY KEY ("tenantId", "key"),
    CONSTRAINT "reseller_quota_overage_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,63}$'),
    CONSTRAINT "reseller_quota_overage_priced_iff_overage" CHECK (
        ("mode" = 'stop' AND "unitPrice" IS NULL AND "currencyCode" IS NULL)
     OR ("mode" = 'overage' AND "unitPrice" > 0 AND "currencyCode" ~ '^[A-Z]{3}$')),
    CONSTRAINT "reseller_quota_overage_reason_present" CHECK (length(btrim("reason")) > 0)
);

ALTER TABLE "tenant"."reseller_quota_overage" ADD CONSTRAINT "reseller_quota_overage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE tenant.reseller_quota_overage ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.reseller_quota_overage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.reseller_quota_overage
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON tenant.reseller_quota_overage
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
