-- F-092-ak — rejecting a payment by hand is an audited admin action, beside
-- `payment_manual_confirm` (F-092-z).
--
-- Enum value only. Its own value rather than reusing the confirmation's: a
-- credit by hand and a refusal by hand are opposite acts on someone's money,
-- and the trail must tell them apart.
--
-- Rollback: none possible, and none needed. Postgres cannot drop an enum value;
-- an unused one is inert (see 20260912000300_settlement_admin_actions).

-- AlterEnum
ALTER TYPE "audit"."AdminAction" ADD VALUE 'payment_manual_reject';
