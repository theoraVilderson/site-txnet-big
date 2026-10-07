-- RT-1-b (ADR-0121) — `Admin` and `Support` hold `realtime.tenant.read`, so a
-- tenant's operators hear its `tenant:` channel. Until now only SuperAdmin did
-- (`*`), so a reseller heard no `tenant:` event at all.
--
-- The permission is not the boundary on its own: `gateway-service` also
-- requires the connection's tenant to be the channel's. Hearing your own
-- tenant's page refreshes is not a power, so a tenant-made role may grant it
-- too (F-018-n2).
--
-- On a fresh database the roles do not exist yet — `prisma/seed.js` creates
-- them after migrations run and makes the same grant. The trigger from
-- 20260913000000 notifies on the insert, so open tokens refresh once (ADR-0043).
--
-- Rollback: delete the `realtime.tenant.read` grants from `Admin` and `Support`.

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'realtime.tenant.read')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'realtime.tenant.read'
WHERE r.name IN ('Admin', 'Support') AND r."tenantId" IS NULL
ON CONFLICT DO NOTHING;
