-- F-102-b (D-31) — creating, changing and deleting a payment gateway is an
-- audited admin action, like the grants beside it (F-096-e).
--
-- Enum values only. Three rather than reusing `gateway_toggle` or
-- `tenant_gateway_config_change`: the trail has to tell a gateway that was
-- deleted from one that was switched off, because only the second can still be
-- found behind the payments that used it. The target is the existing `gateway`
-- value, for a platform row and a tenant row alike; `newValue.source` says which.
--
-- Rollback: none possible, and none needed. Postgres cannot drop an enum value;
-- an unused one is inert (see 20260912000300_settlement_admin_actions).

-- AlterEnum
ALTER TYPE "audit"."AdminAction" ADD VALUE 'gateway_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'gateway_update';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'gateway_delete';
