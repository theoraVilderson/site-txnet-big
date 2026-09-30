-- F-118-ap: staff read and set the metered cap (F-118-ao) — a tenant's
-- default and one user's own number. Each change is an admin act, written to
-- `audit.admin_audit_log` in its transaction: against the tenant for its
-- default, against the user for their number.
--
-- Additive; rollback: none needed — an enum value no row uses is inert
-- (Postgres cannot drop one).

ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_limit_tenant_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_limit_user_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_limit_user_remove';
