-- A reseller package names the language its name and description are written in (PK-1-c, ADR-0154 (5)).
--
-- The text itself is locale-service's, under `packages.p_<id>.name` /
-- `.description`; this column says which language the owner wrote, so every
-- other language is drafted from it. Nullable and additive: a package from
-- before it reads as `DEFAULT_LANGUAGE`, and its `name` column stays the text.

ALTER TABLE "tenant"."tenant_feature_package" ADD COLUMN "sourceLang" TEXT;
