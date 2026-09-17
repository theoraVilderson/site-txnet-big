-- F-018-c — the platform owner creates a reseller.
--
-- Two audit enum values and the `tenant.manage` permission. `SuperAdmin` holds
-- it through `*`; it is granted to no other role, because a reseller's owner
-- holds `Admin` and reseller administration is the platform owner's alone (the
-- service refuses any other tenant too).
--
-- Rollback: delete the permission. Postgres cannot drop an enum value; the two
-- stay, unused.

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'tenant_create';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'tenant';

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'tenant.manage')
ON CONFLICT (key) DO NOTHING;
