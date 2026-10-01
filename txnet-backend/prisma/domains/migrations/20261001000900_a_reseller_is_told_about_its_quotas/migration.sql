-- F-019-v8 (ADR-0107 point 11, user 2026-10-01): a reseller is alerted at
-- 80%, at 100% (overage started, or stopped), when it is stopped for want of
-- money, and by a daily digest of refused units and overage at 09:00.
--
--   reseller_quota_alert   — one row per alert told (tenant, meter, window, period, level);
--                            the row is the "told once". Insert only.
--   reseller_quota_refusal — refused acts and units per (tenant, meter, day on the quota
--                            clock), written after the refused act rolled back.
--
-- Strict tenant RLS, as reseller_quota_usage. Additive; rollback: DROP both tables.

CREATE TABLE "tenant"."reseller_quota_alert" (
    "tenantId" UUID NOT NULL,
    "meter" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "level" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reseller_quota_alert_pkey" PRIMARY KEY ("tenantId", "meter", "period", "periodStart", "level"),
    CONSTRAINT "reseller_quota_alert_period" CHECK ("period" IN ('day', 'week', 'month')),
    CONSTRAINT "reseller_quota_alert_level" CHECK ("level" IN ('80', '100', 'stopped', 'digest'))
);

CREATE TABLE "tenant"."reseller_quota_refusal" (
    "tenantId" UUID NOT NULL,
    "meter" TEXT NOT NULL,
    "dayStart" TIMESTAMP(3) NOT NULL,
    "acts" INTEGER NOT NULL,
    "units" INTEGER NOT NULL,
    "lastStoppedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reseller_quota_refusal_pkey" PRIMARY KEY ("tenantId", "meter", "dayStart"),
    CONSTRAINT "reseller_quota_refusal_counts" CHECK ("acts" > 0 AND "units" > 0),
    CONSTRAINT "reseller_quota_refusal_stopped_by" CHECK ("lastStoppedBy" IN ('stop', 'wallet_empty', 'spend_cap', 'price_unavailable'))
);

CREATE INDEX "reseller_quota_refusal_dayStart_idx" ON "tenant"."reseller_quota_refusal"("dayStart");

ALTER TABLE "tenant"."reseller_quota_alert" ADD CONSTRAINT "reseller_quota_alert_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant"."reseller_quota_refusal" ADD CONSTRAINT "reseller_quota_refusal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE tenant.reseller_quota_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.reseller_quota_alert FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.reseller_quota_alert
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON tenant.reseller_quota_alert
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

ALTER TABLE tenant.reseller_quota_refusal ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.reseller_quota_refusal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.reseller_quota_refusal
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON tenant.reseller_quota_refusal
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
