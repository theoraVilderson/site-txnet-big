-- F-038-j1 — the `ai.manage` permission, granted to `Admin` as
-- `campaign.manage` is (20260917000100). `prisma/seed.js` makes the same grant.
-- A tenant's Admin manages its own tenant's AI — settings, offers, at-risk
-- lists, the uplift report; `ai-service` reads and writes only the gate's
-- tenant (`admin/ai-admin.controller.ts`).
--
-- Rollback: delete the `role_permission` rows and the permission.

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'ai.manage')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'ai.manage'
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;
