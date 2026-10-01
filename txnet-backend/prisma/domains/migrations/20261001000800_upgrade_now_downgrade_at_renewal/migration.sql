-- F-019-v7 (ADR-0107 point 9, user 2026-10-01): a reseller's upgrade applies
-- at once, prorated from its billing wallet; a downgrade — a cheaper package,
-- or yearly -> monthly — waits for the renewal.
--
--   tenant_subscription.nextPackageId / nextBillingModel — the change that waits;
--     both set or both null. The renewal applies and clears them.
--   TenantBillingReasonType.subscription_upgrade_charge — the prorated debit.
--
-- Additive; rollback: DROP the two columns. An enum value cannot be dropped
-- in place; an unused one is harmless.

ALTER TYPE "tenant"."TenantBillingReasonType" ADD VALUE IF NOT EXISTS 'subscription_upgrade_charge';

ALTER TABLE "tenant"."tenant_subscription"
    ADD COLUMN "nextPackageId" UUID,
    ADD COLUMN "nextBillingModel" "tenant"."TenantBillingModel",
    ADD CONSTRAINT "tenant_subscription_next_both" CHECK (("nextPackageId" IS NULL) = ("nextBillingModel" IS NULL)),
    ADD CONSTRAINT "tenant_subscription_next_period" CHECK ("nextBillingModel" IS NULL OR "nextBillingModel" <> 'pay_as_you_go_metered');

ALTER TABLE "tenant"."tenant_subscription"
    ADD CONSTRAINT "tenant_subscription_nextPackageId_fkey" FOREIGN KEY ("nextPackageId")
    REFERENCES "tenant"."tenant_feature_package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "tenant_subscription_nextPackageId_idx" ON "tenant"."tenant_subscription"("nextPackageId");
