-- F-019-a (D-41) — a reseller's billing wallet with the platform, held by the
-- database for every writer, not only by `TenantBillingLedger`.
--
-- 1. Prepaid only (D-01): the balance never goes below zero — on the cache and
--    on every ledger row's `balanceAfter`. The ledger refuses first with a named
--    error; these CHECKs are for any other writer.
-- 2. `amount` is strictly positive; the sign is `direction` (as billing's ledger).
-- 3. At most one entry per (reasonType, referenceId): a payment, a renewal or an
--    admin request moves the balance once. A NULL reference is not unique.
-- 4. Two audit enum values and the `tenant_billing.adjust` permission, granted
--    to `Admin` as `payment.confirm_manual` is; the service admits only the
--    platform owner's. `prisma/seed.js` makes the same grant.
--
-- Rollback: drop the three constraints and the index, delete the
-- `role_permission` row and the permission.
-- Postgres cannot drop an enum value; the two stay, unused.

ALTER TABLE "tenant"."tenant_billing_wallet"
  ADD CONSTRAINT "tenant_billing_wallet_balance_non_negative" CHECK ("cachedBalance" >= 0);

ALTER TABLE "tenant"."tenant_billing_transaction"
  ADD CONSTRAINT "tenant_billing_transaction_balance_after_non_negative" CHECK ("balanceAfter" >= 0),
  ADD CONSTRAINT "tenant_billing_transaction_amount_positive" CHECK ("amount" > 0);

CREATE UNIQUE INDEX "tenant_billing_transaction_reason_reference_key"
  ON "tenant"."tenant_billing_transaction" ("reasonType", "referenceId")
  WHERE "referenceId" IS NOT NULL;

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'tenant_billing_adjust';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'tenant_billing_wallet';

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'tenant_billing.adjust')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'tenant_billing.adjust'
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;
