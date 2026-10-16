-- F-1003 (ADR-0149 (4)): "this user costs more than they pay". Additive: the
-- tenant's threshold beside its renewal window, and the claim that tells a
-- user's loss once per tenant month.

ALTER TABLE "billing"."analytics_setting" ADD COLUMN "lossAlertPercent" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "billing"."analytics_setting" ADD CONSTRAINT "analytics_setting_loss_alert_percent" CHECK ("lossAlertPercent" BETWEEN 0 AND 500);

CREATE TABLE "billing"."analytics_loss_alert" (
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "month" DATE NOT NULL,
    "net" DECIMAL(18,2) NOT NULL,
    "cost" DECIMAL(18,2) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_loss_alert_pkey" PRIMARY KEY ("tenantId", "userId", "month")
);

-- Strict shape, as `20261015001300_analytics_rollup`.
ALTER TABLE "billing"."analytics_loss_alert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing"."analytics_loss_alert" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing"."analytics_loss_alert"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "billing"."analytics_loss_alert"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."analytics_loss_alert" TO txnet_app, txnet_cross_tenant;
