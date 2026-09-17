-- F-019-g — the platform owner gives an unpaid reseller more time to pay.
--
-- 1. `tenant_subscription.graceUntil`: the renewal suspends an unpaid reseller
--    no earlier than this, on top of `currentPeriodEnd` + `renewalGraceDays`.
--    Cleared by a paid renewal. No money moves: no ledger entry is written.
-- 2. The audit value `tenant_subscription_grace`.
--
-- Rollback: drop the column. The enum value stays (Postgres cannot drop one);
-- nothing writes it once the route is gone.

ALTER TABLE "tenant"."tenant_subscription" ADD COLUMN "graceUntil" TIMESTAMP(3);

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'tenant_subscription_grace';
