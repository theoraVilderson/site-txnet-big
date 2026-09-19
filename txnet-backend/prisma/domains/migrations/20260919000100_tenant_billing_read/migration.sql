-- F-019-j (D-41) — the platform owner reads one reseller's billing ledger
-- (`GET /api/billing/tenant-wallets/:tenantId/transactions`).
--
-- The `tenant_billing.read` permission, granted to `Admin` as
-- `tenant_billing.adjust` (F-019-a) is: the reseller's page shows the ledger
-- and the adjustment together, so the two keys travel together today. They are
-- two keys because reading what the platform charged a reseller is not moving
-- its balance — a support role may later hold this one alone.
-- The service admits only a caller whose tenant is the `platform_owner`, so a
-- reseller that grants itself the key is still refused (ADR-0053).
-- `prisma/seed.js` makes the same grant.
--
-- Rollback: delete the `role_permission` row and the permission.

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'tenant_billing.read')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'tenant_billing.read'
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;
