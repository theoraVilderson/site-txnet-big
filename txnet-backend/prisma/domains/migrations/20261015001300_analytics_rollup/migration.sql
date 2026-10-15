-- F-1001-a: the analytics rollup (billing/contract.analytics.md "Rollup
-- tables"). Every analytics figure is read from these; only the rollup worker
-- reads a ledger. Additive: four new tables and the per-tenant state beside them.

-- CreateEnum
CREATE TYPE "billing"."AnalyticsSaleKind" AS ENUM ('package', 'usage');

-- CreateTable — a flow: what was sold during one tenant day.
CREATE TABLE "billing"."analytics_sales_day" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "productId" UUID,
    "variantId" UUID,
    "panelId" UUID,
    "kind" "billing"."AnalyticsSaleKind" NOT NULL,
    "gross" DECIMAL(18,2) NOT NULL,
    "refunds" DECIMAL(18,2) NOT NULL,
    "net" DECIMAL(18,2) NOT NULL,
    "orders" INTEGER NOT NULL,
    "bytesSold" BIGINT NOT NULL,
    "discounts" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "analytics_sales_day_pkey" PRIMARY KEY ("id")
);

-- CreateTable — a flow per user, sparse: only users with activity that day.
CREATE TABLE "billing"."analytics_user_day" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "net" DECIMAL(18,2) NOT NULL,
    "orders" INTEGER NOT NULL,
    "topUps" DECIMAL(18,2) NOT NULL,
    "firstPurchase" BOOLEAN NOT NULL,

    CONSTRAINT "analytics_user_day_pkey" PRIMARY KEY ("id")
);

-- CreateTable — a flow: top-up attempts by gateway kind; a NULL kind is the
-- coupon and gift credits no gateway carried.
CREATE TABLE "billing"."analytics_payment_day" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "gatewayKind" "billing"."PaymentProviderName",
    "started" INTEGER NOT NULL,
    "settled" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "settledAmount" DECIMAL(18,2) NOT NULL,
    "giftsCredited" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "analytics_payment_day_pkey" PRIMARY KEY ("id")
);

-- CreateTable — a stock: what stood at the end of one tenant day; never summed over days.
CREATE TABLE "billing"."analytics_stock_day" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "productId" UUID,
    "panelId" UUID,
    "activeGrants" INTEGER NOT NULL,
    "frozenGrants" INTEGER NOT NULL,
    "activeUsers" INTEGER NOT NULL,
    "bytesUsed" BIGINT NOT NULL,

    CONSTRAINT "analytics_stock_day_pkey" PRIMARY KEY ("id")
);

-- CreateTable — one row per tenant: the zone its days were cut in, the
-- version a read cache is keyed by, and whether a whole rebuild is running.
CREATE TABLE "billing"."analytics_rollup_state" (
    "tenantId" UUID NOT NULL,
    "timeZone" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "refreshedAt" TIMESTAMP(3),
    "rebuildingSince" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_rollup_state_pkey" PRIMARY KEY ("tenantId")
);

-- The grain of each table is its unique key. NULLS NOT DISTINCT: a sale with
-- no product or panel is still one cell, never one per pass.
CREATE UNIQUE INDEX "analytics_sales_day_grain_key" ON "billing"."analytics_sales_day"("tenantId", "day", "currencyCode", "productId", "variantId", "panelId", "kind") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "analytics_user_day_grain_key" ON "billing"."analytics_user_day"("tenantId", "day", "currencyCode", "userId");
CREATE INDEX "analytics_user_day_tenantId_userId_idx" ON "billing"."analytics_user_day"("tenantId", "userId");
CREATE UNIQUE INDEX "analytics_payment_day_grain_key" ON "billing"."analytics_payment_day"("tenantId", "day", "currencyCode", "gatewayKind") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "analytics_stock_day_grain_key" ON "billing"."analytics_stock_day"("tenantId", "day", "productId", "panelId") NULLS NOT DISTINCT;

-- Strict shape (`20260909001500_row_level_security_all_tables`, shape A), on all five.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing.analytics_sales_day',
    'billing.analytics_user_day',
    'billing.analytics_payment_day',
    'billing.analytics_stock_day',
    'billing.analytics_rollup_state'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);
    EXECUTE format('DROP POLICY IF EXISTS cross_tenant ON %s', t);
    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);
  END LOOP;
END
$$;
