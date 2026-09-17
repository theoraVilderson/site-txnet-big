-- F-018-o — the audit value for forcing a package's feature list onto every
-- current subscriber. No table changes: an added key reaching subscribers and
-- a forced apply write `tenant_feature_entitlement` rows only.
--
-- Rollback: none needed; Postgres cannot drop an enum value, it stays unused.

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'tenant_package_apply';
