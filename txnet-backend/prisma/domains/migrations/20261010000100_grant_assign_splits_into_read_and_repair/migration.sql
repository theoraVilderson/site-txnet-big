-- KS-1-a (ADR-0140) — `grant.assign` splits by the kind of act: `grant.read`
-- sees a user's services, `grant.repair` fixes a config or the link without
-- moving value, and `grant.assign` keeps everything that moves value.
--
-- Nobody loses anything (ADR-0140 (3)): every holder of `grant.assign` gets
-- both parts, from the same source it held it by —
--   * a role (`identity.role_permission`), templates and tenant-made alike;
--   * a group (`governance.user_group_permission`);
--   * a person (`identity.user_permission`) with the same effect, reason and
--     giver, so a `take` of `grant.assign` takes both parts too and a removal
--     still wins (ADR-0138 (1)).
-- The triggers from 20260913000000 and AC-1-m notify on each insert, so the
-- holders' tokens move once. Adds rows only; deletes and rewrites nothing.
--
-- Rollback: delete the `grant.read` and `grant.repair` permission rows (their
-- holder rows cascade from `user_permission`/`user_group_permission`; delete
-- the `role_permission` rows first).

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'grant.read'), (gen_random_uuid(), 'grant.repair')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT rp."roleId", np.id
FROM identity.role_permission rp
JOIN identity.permission op ON op.id = rp."permissionId" AND op.key = 'grant.assign'
CROSS JOIN identity.permission np
WHERE np.key IN ('grant.read', 'grant.repair')
ON CONFLICT DO NOTHING;

INSERT INTO governance.user_group_permission ("groupId", "tenantId", "permissionId")
SELECT gp."groupId", gp."tenantId", np.id
FROM governance.user_group_permission gp
JOIN identity.permission op ON op.id = gp."permissionId" AND op.key = 'grant.assign'
CROSS JOIN identity.permission np
WHERE np.key IN ('grant.read', 'grant.repair')
ON CONFLICT DO NOTHING;

INSERT INTO identity.user_permission ("userId", "permissionId", "tenantId", effect, reason, "grantedByUserId", "createdAt", "updatedAt")
SELECT up."userId", np.id, up."tenantId", up.effect, up.reason, up."grantedByUserId", up."createdAt", now()
FROM identity.user_permission up
JOIN identity.permission op ON op.id = up."permissionId" AND op.key = 'grant.assign'
CROSS JOIN identity.permission np
WHERE np.key IN ('grant.read', 'grant.repair')
ON CONFLICT DO NOTHING;
