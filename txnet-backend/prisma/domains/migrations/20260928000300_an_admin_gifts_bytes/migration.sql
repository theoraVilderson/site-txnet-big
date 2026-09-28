-- F-311-l: an admin gifts bytes to a metered Grant. The gift raises
-- `purchasedBytes` with no wallet debit, and its `quota_adjustment` row is told
-- apart from a prepaid admin move (`admin_grant`) and from every bought byte by
-- a source of its own.
--
-- Additive. A value cannot be dropped from a Postgres enum in place; rollback
-- is to leave it unused.

ALTER TYPE "entitlement"."GrantSource" ADD VALUE IF NOT EXISTS 'admin_gift';
