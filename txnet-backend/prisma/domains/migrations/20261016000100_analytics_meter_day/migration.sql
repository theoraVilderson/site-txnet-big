-- F-1001-n (ADR-0148): usage per meter, so a product that is not VPN access
-- has its own measure in analytics. Additive: one new flow table.

-- CreateTable — a flow: what one tenant day used of each meter, in its unit.
CREATE TABLE "billing"."analytics_meter_day" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "productId" UUID,
    "panelId" UUID,
    "meterKey" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "grants" INTEGER NOT NULL,

    CONSTRAINT "analytics_meter_day_pkey" PRIMARY KEY ("id")
);

-- The grain. NULLS NOT DISTINCT: a use with no product or panel is still one cell.
CREATE UNIQUE INDEX "analytics_meter_day_grain_key" ON "billing"."analytics_meter_day"("tenantId", "day", "productId", "panelId", "meterKey") NULLS NOT DISTINCT;

-- Strict shape, as `20261015001300_analytics_rollup`.
ALTER TABLE "billing"."analytics_meter_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing"."analytics_meter_day" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing"."analytics_meter_day"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "billing"."analytics_meter_day"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."analytics_meter_day" TO txnet_app, txnet_cross_tenant;

-- The table starts empty: every tenant is rebuilt whole by the next tick, and
-- reads say `rebuilding` until it has been (as `20261015001400`). The rollup
-- is derived, so nothing is lost.
UPDATE "billing"."analytics_rollup_state" SET "rebuildingSince" = now();
