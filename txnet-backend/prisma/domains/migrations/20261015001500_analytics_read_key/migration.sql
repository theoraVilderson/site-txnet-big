-- F-1001-b — `analytics.read`: a tenant's analytics page, apart from
-- `report.read` so a seat can be given the numbers and nothing else.
--
-- billing/contract.analytics.md principle 8 said "granted to Admin"; since
-- ADR-0144 there is no Admin role — staff keys come from groups. So whoever
-- reads reports reads analytics: every holder of `report.read` gets it, from
-- the same source it held it by — a role, a group, or a person (same effect,
-- reason, giver and window, so a `take` still wins and a window closes both,
-- ADR-0138 (1)). The triggers notify on each insert, so the holders' tokens
-- move once. Adds rows only.
--
-- Rollback: delete the `role_permission` rows for the key, then its
-- `permission` row (the group and person rows cascade).

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'analytics.read')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT rp."roleId", np.id
FROM identity.role_permission rp
JOIN identity.permission op ON op.id = rp."permissionId" AND op.key = 'report.read'
CROSS JOIN identity.permission np
WHERE np.key = 'analytics.read'
ON CONFLICT DO NOTHING;

INSERT INTO governance.user_group_permission ("groupId", "tenantId", "permissionId")
SELECT gp."groupId", gp."tenantId", np.id
FROM governance.user_group_permission gp
JOIN identity.permission op ON op.id = gp."permissionId" AND op.key = 'report.read'
CROSS JOIN identity.permission np
WHERE np.key = 'analytics.read'
ON CONFLICT DO NOTHING;

INSERT INTO identity.user_permission ("userId", "permissionId", "tenantId", effect, reason, "grantedByUserId", "createdAt", "updatedAt", "startsAt", "endsAt", "openedAt")
SELECT up."userId", np.id, up."tenantId", up.effect, up.reason, up."grantedByUserId", up."createdAt", now(), up."startsAt", up."endsAt", up."openedAt"
FROM identity.user_permission up
JOIN identity.permission op ON op.id = up."permissionId" AND op.key = 'report.read'
CROSS JOIN identity.permission np
WHERE np.key = 'analytics.read'
ON CONFLICT DO NOTHING;
