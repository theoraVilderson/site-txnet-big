-- F-102-c (D-31) — every tenant manages its own payment gateways, so the
-- `Admin` role holds `gateway.manage`. SuperAdmin already holds it as `*`
-- (F-101-d).
--
-- The permission is not the boundary: `GatewayAdminService` confines a tenant
-- to its own `tenant_gateway_config` rows and keeps platform gateways, other
-- tenants' gateways and verification for the platform owner.
--
-- On a fresh database the role does not exist yet — `prisma/seed.js` creates it
-- after migrations run and makes the same grant — so the second statement is a
-- no-op there by design. The trigger from 20260913000000 notifies on the
-- insert, so open Admin tokens refresh once (ADR-0043).
--
-- Rollback: delete the `gateway.manage` grant from `Admin`.

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'gateway.manage')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'gateway.manage'
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;
