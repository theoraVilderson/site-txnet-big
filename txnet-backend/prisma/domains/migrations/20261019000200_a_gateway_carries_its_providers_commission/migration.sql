-- F-1001-v: what a gateway's provider deducts from the merchant — a percent
-- and/or a fixed amount, from a day on — so each settled payment costs that
-- commission minus the fee its payer was charged, as `gateway` in
-- analytics_cost_day. Additive: an enum value, one table.

ALTER TYPE "billing"."AnalyticsCostKind" ADD VALUE 'gateway';

CREATE TABLE "billing"."gateway_commission" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "gatewayId" UUID,
    "tenantGatewayConfigId" UUID,
    "percent" DECIMAL(9,4) NOT NULL,
    "fixedAmount" DECIMAL(20,4) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_commission_pkey" PRIMARY KEY ("id"),
    -- One gateway, as payment_transaction names one: the platform's or a tenant's own.
    CONSTRAINT "gateway_commission_one_gateway" CHECK (("gatewayId" IS NULL) <> ("tenantGatewayConfigId" IS NULL)),
    CONSTRAINT "gateway_commission_percent" CHECK ("percent" BETWEEN 0 AND 100),
    CONSTRAINT "gateway_commission_fixed" CHECK ("fixedAmount" >= 0),
    CONSTRAINT "gateway_commission_currency" CHECK ("currencyCode" ~ '^[A-Z]{3}$')
);
ALTER TABLE "billing"."gateway_commission" ADD CONSTRAINT "gateway_commission_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "billing"."payment_gateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing"."gateway_commission" ADD CONSTRAINT "gateway_commission_tenantGatewayConfigId_fkey" FOREIGN KEY ("tenantGatewayConfigId") REFERENCES "tenant"."tenant_gateway_config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- The rollup's read: a payment's gateway, the commission in effect on its day.
CREATE INDEX "gateway_commission_gatewayId_effectiveFrom_idx" ON "billing"."gateway_commission"("gatewayId", "effectiveFrom");
CREATE INDEX "gateway_commission_tenantGatewayConfigId_effectiveFrom_idx" ON "billing"."gateway_commission"("tenantGatewayConfigId", "effectiveFrom");

-- History: a commission is never edited — a change is a new row from its day.
CREATE TRIGGER gateway_commission_is_history BEFORE UPDATE ON "billing"."gateway_commission"
  FOR EACH ROW EXECUTE FUNCTION billing.general_expense_is_history();

-- Its tenant's only; read and added, never updated or deleted by the app.
ALTER TABLE "billing"."gateway_commission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing"."gateway_commission" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing"."gateway_commission"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "billing"."gateway_commission"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON "billing"."gateway_commission" TO txnet_app, txnet_cross_tenant;
