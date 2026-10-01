-- F-019-v2 (ADR-0107 points 4-7, 10, 12, user 2026-10-01): the quota engine's
-- state. A quota is consumed by one call at the act (shared-core
-- `ResellerQuota.consume`), given back by one (`release`):
--
--   reseller_quota_usage — one row per (tenant, meter, sourceRef): the act's
--                          units, how many were included and how many sold past
--                          the quota, the price, and the billing-wallet entry
--                          that paid them. Released rows give their units and
--                          their charge back. Strict tenant RLS.
--   reseller_overage_cap — the reseller's own ceiling on what overage may cost
--                          it per subscription month. Strict tenant RLS.
--
-- tenant_subscription_setting.quotaTimeZone — the clock a sold quota's day
-- (from 00:00) and week (from Saturday) are read on; default Asia/Tehran.
-- Two ledger reasons: quota_overage_charge / quota_overage_refund.
--
-- Additive; rollback: DROP TABLE "tenant"."reseller_overage_cap",
-- "tenant"."reseller_quota_usage"; ALTER TABLE
-- "tenant"."tenant_subscription_setting" DROP COLUMN "quotaTimeZone".
-- (Enum values cannot be dropped; unused they are harmless.)

ALTER TYPE "tenant"."TenantBillingReasonType" ADD VALUE 'quota_overage_charge';
ALTER TYPE "tenant"."TenantBillingReasonType" ADD VALUE 'quota_overage_refund';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'reseller_overage_cap_set';

ALTER TABLE "tenant"."tenant_subscription_setting"
  ADD COLUMN "quotaTimeZone" TEXT NOT NULL DEFAULT 'Asia/Tehran',
  ADD CONSTRAINT "tenant_subscription_setting_quota_time_zone_shape" CHECK ("quotaTimeZone" ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$');

CREATE TABLE "tenant"."reseller_quota_usage" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "meter" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "qty" INTEGER NOT NULL,
    "includedQty" INTEGER NOT NULL,
    "overageQty" INTEGER NOT NULL,
    "unitPrice" DECIMAL(18,2),
    "overageAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currencyCode" TEXT,
    "chargeTransactionId" UUID,
    "releasedAt" TIMESTAMP(3),
    "refundTransactionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reseller_quota_usage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reseller_quota_usage_meter_shape" CHECK ("meter" ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
    CONSTRAINT "reseller_quota_usage_source_ref_shape" CHECK (length("sourceRef") BETWEEN 1 AND 200),
    CONSTRAINT "reseller_quota_usage_period" CHECK ("periodEnd" > "periodStart"),
    CONSTRAINT "reseller_quota_usage_split" CHECK ("qty" > 0 AND "includedQty" >= 0 AND "overageQty" >= 0 AND "includedQty" + "overageQty" = "qty"),
    CONSTRAINT "reseller_quota_usage_priced_iff_overage" CHECK (
        ("overageQty" = 0 AND "unitPrice" IS NULL AND "currencyCode" IS NULL AND "overageAmount" = 0 AND "chargeTransactionId" IS NULL)
     OR ("overageQty" > 0 AND "unitPrice" > 0 AND "currencyCode" ~ '^[A-Z]{3}$' AND "overageAmount" = "overageQty" * "unitPrice" AND "chargeTransactionId" IS NOT NULL)),
    CONSTRAINT "reseller_quota_usage_refund_after_release" CHECK ("refundTransactionId" IS NULL OR "releasedAt" IS NOT NULL)
);

CREATE UNIQUE INDEX "reseller_quota_usage_tenantId_meter_sourceRef_key" ON "tenant"."reseller_quota_usage"("tenantId", "meter", "sourceRef");
CREATE INDEX "reseller_quota_usage_tenantId_meter_createdAt_idx" ON "tenant"."reseller_quota_usage"("tenantId", "meter", "createdAt");
CREATE INDEX "reseller_quota_usage_tenantId_createdAt_idx" ON "tenant"."reseller_quota_usage"("tenantId", "createdAt");

ALTER TABLE "tenant"."reseller_quota_usage" ADD CONSTRAINT "reseller_quota_usage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE tenant.reseller_quota_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.reseller_quota_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.reseller_quota_usage
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON tenant.reseller_quota_usage
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

CREATE TABLE "tenant"."reseller_overage_cap" (
    "tenantId" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "setByUserId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reseller_overage_cap_pkey" PRIMARY KEY ("tenantId"),
    CONSTRAINT "reseller_overage_cap_amount_not_negative" CHECK ("amount" >= 0),
    CONSTRAINT "reseller_overage_cap_currency_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$')
);

ALTER TABLE "tenant"."reseller_overage_cap" ADD CONSTRAINT "reseller_overage_cap_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE tenant.reseller_overage_cap ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.reseller_overage_cap FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.reseller_overage_cap
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON tenant.reseller_overage_cap
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
