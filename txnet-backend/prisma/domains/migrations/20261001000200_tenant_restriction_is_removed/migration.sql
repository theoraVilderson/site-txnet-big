-- F-019-u (ADR-0106): tenant.tenant_restriction is removed. It was in the
-- schema since the first draft and read or written by no code; a reseller's
-- caps live in reseller_limit_setting / package_limit / reseller_limit.
-- Its RLS policy and index go with it. The RestrictionScope enum stays:
-- governance.user_restriction still uses it.
--
-- Destructive (DROP TABLE). 0 rows on dev, 2026-10-01. Rollback: the
-- CREATE TABLE, index, foreign key and RLS policy from 20260908000000_init
-- and 20260909001500_row_level_security_all_tables.

DROP TABLE "tenant"."tenant_restriction";
