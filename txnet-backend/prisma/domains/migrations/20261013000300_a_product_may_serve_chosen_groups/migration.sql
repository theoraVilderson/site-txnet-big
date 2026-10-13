-- PT-1-b (ADR-0142 (4)): a product may be sold only to chosen user groups of
-- its tenant. No row = every user, as before. Additive only.

-- The key `product_audience` points at, so an audience row is its product's tenant's.
CREATE UNIQUE INDEX "product_id_tenantId_key" ON "catalog"."product"("id", "tenantId");

-- CreateTable
CREATE TABLE "catalog"."product_audience" (
    "productId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_audience_pkey" PRIMARY KEY ("productId", "groupId")
);

CREATE INDEX "product_audience_tenantId_idx" ON "catalog"."product_audience"("tenantId");
CREATE INDEX "product_audience_groupId_idx" ON "catalog"."product_audience"("groupId");

-- The product's own tenant's groups only; a removed product takes its rows.
ALTER TABLE "catalog"."product_audience" ADD CONSTRAINT "product_audience_productId_tenantId_fkey" FOREIGN KEY ("productId", "tenantId") REFERENCES "catalog"."product"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
-- A group in use is not deleted (`group_in_use`), as a gateway's audience.
ALTER TABLE "catalog"."product_audience" ADD CONSTRAINT "product_audience_groupId_tenantId_fkey" FOREIGN KEY ("groupId", "tenantId") REFERENCES "governance"."user_group"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Strict shape (`20260909001500_row_level_security_all_tables`, shape A): an
-- audience is read only where its product's tenant sells it, so no tenant
-- reads another's — the platform's included.
ALTER TABLE "catalog"."product_audience" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."product_audience" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "catalog"."product_audience";
CREATE POLICY tenant_isolation ON "catalog"."product_audience"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
DROP POLICY IF EXISTS cross_tenant ON "catalog"."product_audience";
CREATE POLICY cross_tenant ON "catalog"."product_audience"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "catalog"."product_audience" TO txnet_app, txnet_cross_tenant;
