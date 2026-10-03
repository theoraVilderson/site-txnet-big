-- F-707-c (ADR-0111 point 4). A tenant's Admin edits its own wheel.
--
-- 1. The `engagement.manage` permission, granted to `Admin` as `coupon.manage`
--    is (20260914000900). `prisma/seed.js` makes the same grant. The service
--    confines an admin to its own tenant's wheel (RLS).
-- 2. The audit trail of a save: `spin_wheel_version_create` on a
--    `spin_wheel_config`. A version is never edited, so there is no update act.
--
-- Additive. Rollback: delete the `role_permission` rows and the permission.
-- (An enum value cannot be dropped; the two stay, unused.)

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'spin_wheel_version_create';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'spin_wheel_config';

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'engagement.manage')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'engagement.manage'
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;
