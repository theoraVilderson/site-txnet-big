-- F-092-z (ADR-0044 decision 6) — a person may confirm a verifying payment,
-- scoped like `gateway.manage`: the platform owner any payment, a tenant only
-- its own user's payment on its own `tenant_gateway_config`. So the `Admin`
-- role that manages those gateways holds `payment.confirm_manual`; SuperAdmin
-- already holds it as `*` (ADR-0043).
--
-- The permission is not the boundary: `ManualConfirmService` confines a tenant.
-- On a fresh database the role does not exist yet and `prisma/seed.js` makes
-- the same grant. The trigger from 20260913000000 refreshes open Admin tokens.
--
-- Rollback: delete the `payment.confirm_manual` grant from `Admin`.

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'payment.confirm_manual')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'payment.confirm_manual'
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;
