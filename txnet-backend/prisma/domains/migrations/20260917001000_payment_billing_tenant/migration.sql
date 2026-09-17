-- F-019-b (D-41, ADR-0056) — a reseller tops up its billing wallet with the
-- platform through the platform owner's gateways.
--
-- 1. `payment_transaction.billingTenantId`: the reseller whose billing wallet a
--    settled payment credits. NULL is every user top-up. The row itself is the
--    platform owner's (`tenantId`), so RLS, the vault, the webhook scope and the
--    callback host are unchanged.
-- 2. A CHECK for what such a payment may be: on a platform gateway, under no
--    grant, with no coupon discount — the platform is the merchant, and a
--    coupon is a user's.
-- 3. The `tenant_billing.topup` permission, granted to `Admin` as
--    `tenant_billing.adjust` is; the service admits it only inside a reseller.
--    `prisma/seed.js` makes the same grant.
--
-- No FK, as `tenantId` beside it has none (the schema is split per domain).
--
-- Rollback: drop the constraint and the column; delete the
-- `role_permission` row and the permission.

ALTER TABLE "billing"."payment_transaction" ADD COLUMN "billingTenantId" UUID;

ALTER TABLE "billing"."payment_transaction"
  ADD CONSTRAINT "payment_transaction_billing_topup_shape" CHECK (
    "billingTenantId" IS NULL
    OR ("gatewayId" IS NOT NULL AND "grantId" IS NULL AND "discountApplied" = 0)
  );

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'tenant_billing.topup')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'tenant_billing.topup'
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;
