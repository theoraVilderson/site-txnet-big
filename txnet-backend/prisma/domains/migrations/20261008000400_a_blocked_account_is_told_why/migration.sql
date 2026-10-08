-- BAN-1-a (ADR-0133) — a blocked account is told why.
--   statusReason     written by staff with every status change, shown to the
--                    person verbatim; null for an `active` account
--   statusChangedAt  when the status last changed
-- Two permissions: `restriction.assign` (restrict / lift a restriction) to
-- `Admin` and the `Support` template, `user.ban` (ban / lift a ban) to `Admin`
-- alone. `prisma/seed.js` makes the same grants.
--
-- Rollback: drop the two columns; delete the `role_permission` rows and the
-- two permissions.

ALTER TABLE identity."user"
  ADD COLUMN "statusReason" TEXT,
  ADD COLUMN "statusChangedAt" TIMESTAMP(3);

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'restriction.assign'), (gen_random_uuid(), 'user.ban')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key IN ('restriction.assign', 'user.ban')
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'restriction.assign'
WHERE r.name = 'Support'
ON CONFLICT DO NOTHING;
