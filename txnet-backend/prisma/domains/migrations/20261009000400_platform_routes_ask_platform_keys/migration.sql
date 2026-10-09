-- AC-1-d (ADR-0135 (5)) — the platform's routes ask the platform's own keys,
-- and the two keys they asked before are retired:
--   tenant.manage -> platform.tenant.create, platform.tenant.manage,
--                    platform.plan.assign, platform.report.read,
--                    platform.impersonate (everything it opened)
--   panel.manage  -> platform.node.manage
-- A role holding an old key by hand is given its replacements first, so no
-- one loses access; then the old rows go, with their role_permission rows
-- (ON DELETE CASCADE). On dev both keys were held by no role (2026-10-09);
-- deletion approved by the user, 2026-10-09.
--
-- Rollback: re-insert the two permission rows; the replacements stay.

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT rp."roleId", np.id
FROM identity.role_permission rp
JOIN identity.permission op ON op.id = rp."permissionId" AND op.key = 'tenant.manage'
JOIN identity.permission np ON np.key IN ('platform.tenant.create', 'platform.tenant.manage', 'platform.plan.assign', 'platform.report.read', 'platform.impersonate')
ON CONFLICT DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT rp."roleId", np.id
FROM identity.role_permission rp
JOIN identity.permission op ON op.id = rp."permissionId" AND op.key = 'panel.manage'
JOIN identity.permission np ON np.key = 'platform.node.manage'
ON CONFLICT DO NOTHING;

DELETE FROM identity.role_permission
WHERE "permissionId" IN (SELECT id FROM identity.permission WHERE key IN ('tenant.manage', 'panel.manage'));

DELETE FROM identity.permission WHERE key IN ('tenant.manage', 'panel.manage');
