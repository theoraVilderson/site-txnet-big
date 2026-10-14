-- GR-1-w (ADR-0143) — `user_group.read`: see a tenant's groups and pick one
-- that gives no keys as an audience (a discount, gateway, product, lottery,
-- wheel or campaign). A group that gives keys needs every one of them instead.
--
-- Whoever manages groups may read them: every holder of `user_group.manage`
-- gets it, from the same source it held it by — a role, a group, or a person
-- (same effect, reason, giver and window, so a `take` still wins and a window
-- closes both, ADR-0138 (1), F-030-a). The triggers notify on each insert, so
-- the holders' tokens move once. Adds rows only.
--
-- Rollback: delete the `role_permission` rows for the key, then its
-- `permission` row (the group and person rows cascade).

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'user_group.read')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT rp."roleId", np.id
FROM identity.role_permission rp
JOIN identity.permission op ON op.id = rp."permissionId" AND op.key = 'user_group.manage'
CROSS JOIN identity.permission np
WHERE np.key = 'user_group.read'
ON CONFLICT DO NOTHING;

INSERT INTO governance.user_group_permission ("groupId", "tenantId", "permissionId")
SELECT gp."groupId", gp."tenantId", np.id
FROM governance.user_group_permission gp
JOIN identity.permission op ON op.id = gp."permissionId" AND op.key = 'user_group.manage'
CROSS JOIN identity.permission np
WHERE np.key = 'user_group.read'
ON CONFLICT DO NOTHING;

INSERT INTO identity.user_permission ("userId", "permissionId", "tenantId", effect, reason, "grantedByUserId", "createdAt", "updatedAt", "startsAt", "endsAt", "openedAt")
SELECT up."userId", np.id, up."tenantId", up.effect, up.reason, up."grantedByUserId", up."createdAt", now(), up."startsAt", up."endsAt", up."openedAt"
FROM identity.user_permission up
JOIN identity.permission op ON op.id = up."permissionId" AND op.key = 'user_group.manage'
CROSS JOIN identity.permission np
WHERE np.key = 'user_group.read'
ON CONFLICT DO NOTHING;
