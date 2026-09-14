-- F-502-c (D-33) — creating, changing and deleting a coupon is an audited admin
-- action, like a gateway's (F-102-b).
--
-- Enum values only. `coupon_create_targeted` stays as it was and unused by this
-- surface: a targeted coupon is a coupon, and the trail records its allowed
-- users in `newValue`. Delete is its own value because a hard delete and a soft
-- one leave different rows behind; `newValue.mode` says which.
--
-- Rollback: none possible, and none needed. Postgres cannot drop an enum value;
-- an unused one is inert (see 20260912000300_settlement_admin_actions).

-- AlterEnum
ALTER TYPE "audit"."AdminAction" ADD VALUE 'coupon_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'coupon_update';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'coupon_delete';
