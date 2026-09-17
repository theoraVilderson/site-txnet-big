-- F-018-d — the packages the platform sells a reseller.
--
-- `yearlyPrice` beside `monthlyPrice`; a unique name, so the platform owner
-- cannot sell two «Growth» packages; the two unused metering columns get `{}`
-- as their default (D-41). The CHECKs hold C-02's shape in the database too: a
-- price is positive, and a package has at least one of its two prices.
--
-- `tenant_feature_package` has no `tenantId` and no RLS policy: it is the
-- platform's catalog, read by every reseller once F-018-e shows it.
--
-- Rollback: drop the constraints, the index and the column. The audit enum
-- values stay, unused (Postgres cannot drop an enum value).

ALTER TABLE "tenant"."tenant_feature_package"
    ADD COLUMN "yearlyPrice" DECIMAL(18,2),
    ALTER COLUMN "usageIncludedJson" SET DEFAULT '{}',
    ALTER COLUMN "overageRuleJson" SET DEFAULT '{}',
    ADD CONSTRAINT "tenant_feature_package_price_positive"
        CHECK (("monthlyPrice" IS NULL OR "monthlyPrice" > 0) AND ("yearlyPrice" IS NULL OR "yearlyPrice" > 0)),
    ADD CONSTRAINT "tenant_feature_package_priced"
        CHECK ("monthlyPrice" IS NOT NULL OR "yearlyPrice" IS NOT NULL);

CREATE UNIQUE INDEX "tenant_feature_package_name_key" ON "tenant"."tenant_feature_package"("name");

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'tenant_package_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'tenant_package_update';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'tenant_feature_package';
