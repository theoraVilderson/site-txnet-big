-- F-033-d — the two support permissions (user, 2026-10-03), granted to `Admin`
-- as `ai.manage` is (20261002001000), and `support.agent` alone to the
-- `Support` template. `prisma/seed.js` makes the same grants.
--   support.agent   the day's work: the inbox, assign, reply, internal notes,
--                   resolve, close (`support-service` agent/ routes)
--   support.manage  the settings: working hours (F-033-g), SLA targets
--                   (F-033-h), categories (F-033-e)
-- Every route reads and writes only the gate's tenant.
--
-- Rollback: delete the `role_permission` rows and the two permissions.

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'support.agent'), (gen_random_uuid(), 'support.manage')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key IN ('support.agent', 'support.manage')
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'support.agent'
WHERE r.name = 'Support'
ON CONFLICT DO NOTHING;
