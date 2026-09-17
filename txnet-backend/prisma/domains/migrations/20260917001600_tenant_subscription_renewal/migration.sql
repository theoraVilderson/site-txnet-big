-- F-019-c (D-41) — a reseller's subscription is renewed from its billing wallet.
--
-- 1. `tenant.suspensionCause` (`manual` | `non_payment`): a payment lifts a
--    suspension the renewal made and never one the platform owner made.
--    Existing suspended tenants were all suspended by hand.
-- 2. `tenant_subscription.renewalWarnedAt`: the owner is warned at most once a
--    day while an unpaid renewal is in grace.
-- 3. `tenant_subscription_setting.renewalGraceDays` (default 3, 0..30).
--
-- Rollback: drop the three columns and the enum. Nothing else reads them.

CREATE TYPE "tenant"."TenantSuspensionCause" AS ENUM ('manual', 'non_payment');

ALTER TABLE "tenant"."tenant" ADD COLUMN "suspensionCause" "tenant"."TenantSuspensionCause";
UPDATE "tenant"."tenant" SET "suspensionCause" = 'manual' WHERE status = 'suspended';

ALTER TABLE "tenant"."tenant_subscription" ADD COLUMN "renewalWarnedAt" TIMESTAMP(3);

ALTER TABLE "tenant"."tenant_subscription_setting"
  ADD COLUMN "renewalGraceDays" INTEGER NOT NULL DEFAULT 3,
  ADD CONSTRAINT "tenant_subscription_setting_grace_days_range" CHECK ("renewalGraceDays" BETWEEN 0 AND 30);
