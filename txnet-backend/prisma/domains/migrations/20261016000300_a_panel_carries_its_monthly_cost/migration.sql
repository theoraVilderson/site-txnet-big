-- F-1002-a: a panel carries a monthly cost (USD, effective-from), the figure
-- analytics spreads over a month's days (F-1002-b). Additive: one table.

CREATE TABLE "network"."panel_cost" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "panelId" UUID NOT NULL,
    "monthlyCostUsd" DECIMAL(18,2) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "panel_cost_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "panel_cost_not_negative" CHECK ("monthlyCostUsd" >= 0)
);
CREATE INDEX "panel_cost_panelId_effectiveFrom_idx" ON "network"."panel_cost"("panelId", "effectiveFrom");

-- The rows go with their panel — one deleted because it never served (F-027-bz) — and with nothing else.
ALTER TABLE "network"."panel_cost" ADD CONSTRAINT "panel_cost_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "network"."panel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- History: a price is never edited. A change is a new row.
CREATE FUNCTION network.panel_cost_is_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'network.panel_cost is history: add a row, never edit one';
END $$;
CREATE TRIGGER panel_cost_is_history BEFORE UPDATE ON "network"."panel_cost"
  FOR EACH ROW EXECUTE FUNCTION network.panel_cost_is_history();

-- Visible exactly when its panel is: the panel's own policy decides (shared
-- read of the platform's, a reseller's own). Written on the platform owner's
-- pool only, as every panel write is.
ALTER TABLE "network"."panel_cost" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "network"."panel_cost" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON "network"."panel_cost" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "network"."panel_cost"
  AS PERMISSIVE FOR SELECT TO txnet_app
  USING (EXISTS (SELECT 1 FROM network.panel p WHERE p."id" = "panelId"));

CREATE POLICY cross_tenant ON "network"."panel_cost"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
