-- F-410-a (D-63) — whether a tenant's users may move their own config to
-- another server, and how many hours they wait between two moves.
-- `network/contract.config-move.md` "Self-move".
--
--   config_self_move_setting         — one row per tenant.
--   config_self_move_product_setting — the tenant's override for one product:
--                                      its own or a platform product it sells.
--
-- Every value is nullable: null is "not set here", and the platform's default
-- (in code, `PLATFORM_SELF_MOVE_DEFAULTS`: on, 24 h) answers — resolved
-- product -> tenant -> platform, as the selling settings resolve (F-027-cg).
-- A row with nothing set is deleted, not kept. Changed in place, not history:
-- every change is audited `config_self_move_settings_set`.
--
-- Strict tenant RLS on both. Additive; rollback: drop both tables (the enum
-- value stays: Postgres cannot remove one).

ALTER TYPE "audit"."AdminAction" ADD VALUE 'config_self_move_settings_set';

CREATE TABLE "network"."config_self_move_setting" (
    "tenantId" UUID NOT NULL,
    "enabled" BOOLEAN,
    "cooldownHours" INTEGER,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "config_self_move_setting_pkey" PRIMARY KEY ("tenantId"),
    CONSTRAINT "config_self_move_setting_cooldown_in_range" CHECK ("cooldownHours" IS NULL OR "cooldownHours" BETWEEN 0 AND 8760)
);

CREATE TABLE "network"."config_self_move_product_setting" (
    "tenantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "enabled" BOOLEAN,
    "cooldownHours" INTEGER,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "config_self_move_product_setting_pkey" PRIMARY KEY ("tenantId", "productId"),
    CONSTRAINT "config_self_move_product_setting_cooldown_in_range" CHECK ("cooldownHours" IS NULL OR "cooldownHours" BETWEEN 0 AND 8760),
    CONSTRAINT "config_self_move_product_setting_productId_fkey" FOREIGN KEY ("productId") REFERENCES "catalog"."product"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "config_self_move_product_setting_productId_idx" ON "network"."config_self_move_product_setting"("productId");

ALTER TABLE network.config_self_move_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.config_self_move_setting FORCE ROW LEVEL SECURITY;
ALTER TABLE network.config_self_move_product_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.config_self_move_product_setting FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "network"."config_self_move_setting", "network"."config_self_move_product_setting" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "network"."config_self_move_setting"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "network"."config_self_move_setting"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

CREATE POLICY tenant_isolation ON "network"."config_self_move_product_setting"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "network"."config_self_move_product_setting"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
