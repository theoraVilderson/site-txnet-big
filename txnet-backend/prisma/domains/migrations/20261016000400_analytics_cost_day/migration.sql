-- F-1002-b: cost attribution — what each tenant day cost, the figure margin
-- is read from (billing/contract.analytics.md "Cost and margin"). Additive:
-- one enum, one flow table.

CREATE TYPE "billing"."AnalyticsCostKind" AS ENUM ('panel', 'idle', 'wholesale', 'subscription');

CREATE TABLE "billing"."analytics_cost_day" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "kind" "billing"."AnalyticsCostKind" NOT NULL,
    "panelId" UUID,
    "servedTenantId" UUID,
    "productId" UUID,
    "userId" UUID,
    "currencyCode" TEXT NOT NULL,
    "cost" DECIMAL(18,6) NOT NULL,
    "bytes" BIGINT NOT NULL,

    CONSTRAINT "analytics_cost_day_pkey" PRIMARY KEY ("id")
);

-- The grain. NULLS NOT DISTINCT: an idle day, an unallocated charge, is still one cell.
CREATE UNIQUE INDEX "analytics_cost_day_grain_key" ON "billing"."analytics_cost_day"("tenantId", "day", "kind", "panelId", "servedTenantId", "productId", "userId", "currencyCode") NULLS NOT DISTINCT;

-- Strict shape, as `20261015001300_analytics_rollup`.
ALTER TABLE "billing"."analytics_cost_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing"."analytics_cost_day" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing"."analytics_cost_day"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "billing"."analytics_cost_day"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."analytics_cost_day" TO txnet_app, txnet_cross_tenant;

-- Every tenant is rebuilt whole by the next tick (as `20261016000100`).
UPDATE "billing"."analytics_rollup_state" SET "rebuildingSince" = now();
