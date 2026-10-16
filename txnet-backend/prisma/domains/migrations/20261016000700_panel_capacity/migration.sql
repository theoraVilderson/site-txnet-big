-- F-1005-a: capacity planning. Additive: one column, two rollup tables.
--
-- 1. A panel's price may name the month's traffic it buys (`monthlyTrafficBytes`,
--    null = none set) — a server is bought as "X TB a month for Y dollars", so
--    the allowance is history beside the price it came with (user, 2026-10-16).
-- 2. `analytics_panel_traffic_day` (a flow): a panel's traffic per UTC date,
--    every tenant's users, written on the rollup of the panel's owner.
-- 3. `analytics_panel_clients_day` (a stock): the Grants with a live config on
--    a panel at a UTC date's last pass — a snapshot, today only.

ALTER TABLE "network"."panel_cost" ADD COLUMN "monthlyTrafficBytes" BIGINT,
  ADD CONSTRAINT "panel_cost_traffic_positive" CHECK ("monthlyTrafficBytes" IS NULL OR "monthlyTrafficBytes" > 0);

CREATE TABLE "billing"."analytics_panel_traffic_day" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "panelId" UUID NOT NULL,
    "bytes" BIGINT NOT NULL,

    CONSTRAINT "analytics_panel_traffic_day_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "analytics_panel_traffic_day_grain_key" ON "billing"."analytics_panel_traffic_day"("tenantId", "day", "panelId");

CREATE TABLE "billing"."analytics_panel_clients_day" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "panelId" UUID NOT NULL,
    "clients" INTEGER NOT NULL,

    CONSTRAINT "analytics_panel_clients_day_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "analytics_panel_clients_day_grain_key" ON "billing"."analytics_panel_clients_day"("tenantId", "day", "panelId");

-- Strict shape, as `20261016000400_analytics_cost_day`.
ALTER TABLE "billing"."analytics_panel_traffic_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing"."analytics_panel_traffic_day" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing"."analytics_panel_traffic_day"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "billing"."analytics_panel_traffic_day"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."analytics_panel_traffic_day" TO txnet_app, txnet_cross_tenant;

ALTER TABLE "billing"."analytics_panel_clients_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing"."analytics_panel_clients_day" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing"."analytics_panel_clients_day"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "billing"."analytics_panel_clients_day"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."analytics_panel_clients_day" TO txnet_app, txnet_cross_tenant;

-- Every tenant is rebuilt whole by the next tick, so a panel's traffic has its history (as `20261016000400`).
UPDATE "billing"."analytics_rollup_state" SET "rebuildingSince" = now();
