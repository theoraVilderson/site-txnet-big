-- A reseller package's two unused metering columns go (PK-1-i, ADR-0154).
--
-- `usageIncludedJson` / `overageRuleJson` were written at init for a metering
-- model D-41 never built. Nothing reads or writes them: the create schema
-- refuses them and every row holds `{}`. What they were meant to say now has
-- its own tables — included sales in `package_product`, past-quota terms in
-- `package_quota_overage` (ADR-0107), wholesale rates in
-- `tenant_package_meter_rate` (F-118-n1). The user chose removal (2026-10-18).

ALTER TABLE "tenant"."tenant_feature_package" DROP COLUMN "usageIncludedJson"; -- contract: PK-1-i
ALTER TABLE "tenant"."tenant_feature_package" DROP COLUMN "overageRuleJson"; -- contract: PK-1-i
