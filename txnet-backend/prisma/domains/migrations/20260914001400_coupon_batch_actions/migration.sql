-- F-502-d (D-33) — a gift-code batch is its own audited thing: made, exported,
-- switched off. Export is audited because whoever holds the file holds the
-- credit. The target is a new `coupon_batch` value: a batch is not one coupon.
--
-- Rollback: none possible, and none needed. Postgres cannot drop an enum value;
-- an unused one is inert (see 20260912000300_settlement_admin_actions).

-- AlterEnum
ALTER TYPE "audit"."AdminAction" ADD VALUE 'coupon_batch_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'coupon_batch_export';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'coupon_batch_deactivate';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE 'coupon_batch';
