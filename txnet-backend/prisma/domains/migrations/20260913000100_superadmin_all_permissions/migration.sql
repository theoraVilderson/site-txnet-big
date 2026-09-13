-- F-101-d (ADR-0043, amended 2026-09-13) — SuperAdmin holds the one permission
-- `*`, which every check reads as "any key", instead of a list someone has to
-- extend each time a feature adds a permission.
--
-- The role's other grants are removed so its token carries exactly `["*"]`:
-- a list beside the wildcard would say nothing and invite the next reader to
-- keep it "complete". The triggers from 20260913000000 notify on each write,
-- so auth-service rewrites the role's fingerprint and open tokens refresh once.
--
-- On a fresh database the role does not exist yet — `prisma/seed.js` creates it
-- after migrations run and makes the same grant — so both statements below are
-- then no-ops by design.
--
-- Rollback: delete the `*` grant and the `*` permission row, then grant the
-- keys `auth-handler/configs/permissions.yaml` lists for SuperAdmin.

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), '*')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = '*'
WHERE r.name = 'SuperAdmin'
ON CONFLICT DO NOTHING;

DELETE FROM identity.role_permission rp
USING identity.role r, identity.permission p
WHERE rp."roleId" = r.id
  AND rp."permissionId" = p.id
  AND r.name = 'SuperAdmin'
  AND p.key <> '*';
