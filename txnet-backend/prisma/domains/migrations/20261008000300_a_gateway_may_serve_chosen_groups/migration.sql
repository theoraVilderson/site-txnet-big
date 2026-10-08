-- F-102-g: a gateway may be offered only to chosen user groups of its owner.
-- No row = everyone, as before. Additive only.

-- The key `gateway_audience` points at, so a tenant gateway's audience row is
-- its owner's.
CREATE UNIQUE INDEX "tenant_gateway_config_id_tenantId_key" ON "tenant"."tenant_gateway_config"("id", "tenantId");

-- CreateTable
CREATE TABLE "billing"."gateway_audience" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "gatewayId" UUID,
    "tenantGatewayConfigId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_audience_pkey" PRIMARY KEY ("id"),
    -- Exactly one gateway, like `payment_gateway_grant`.
    CONSTRAINT "gateway_audience_one_gateway" CHECK (("gatewayId" IS NULL) <> ("tenantGatewayConfigId" IS NULL))
);

CREATE UNIQUE INDEX "gateway_audience_gatewayId_groupId_key" ON "billing"."gateway_audience"("gatewayId", "groupId");
CREATE UNIQUE INDEX "gateway_audience_tenantGatewayConfigId_groupId_key" ON "billing"."gateway_audience"("tenantGatewayConfigId", "groupId");
CREATE INDEX "gateway_audience_tenantId_idx" ON "billing"."gateway_audience"("tenantId");
CREATE INDEX "gateway_audience_groupId_idx" ON "billing"."gateway_audience"("groupId");

-- A group in use is not deleted (`group_in_use`), as a discount rule's.
ALTER TABLE "billing"."gateway_audience" ADD CONSTRAINT "gateway_audience_groupId_tenantId_fkey" FOREIGN KEY ("groupId", "tenantId") REFERENCES "governance"."user_group"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing"."gateway_audience" ADD CONSTRAINT "gateway_audience_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "billing"."payment_gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing"."gateway_audience" ADD CONSTRAINT "gateway_audience_tenantGatewayConfigId_tenantId_fkey" FOREIGN KEY ("tenantGatewayConfigId", "tenantId") REFERENCES "tenant"."tenant_gateway_config"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- A platform gateway has no tenant column: its audience is the platform
-- owner's groups, never a reseller's.
CREATE OR REPLACE FUNCTION billing.gateway_audience_owner_ok() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."gatewayId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tenant.tenant t WHERE t.id = NEW."tenantId" AND t."tenantType" = 'platform_owner'
  ) THEN
    RAISE EXCEPTION 'gateway_audience: a platform gateway is offered to the platform owner''s groups only'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER gateway_audience_owner_ok BEFORE INSERT OR UPDATE ON "billing"."gateway_audience"
  FOR EACH ROW EXECUTE FUNCTION billing.gateway_audience_owner_ok();

-- Strict shape (`20260909001500_row_level_security_all_tables`, shape A).
ALTER TABLE "billing"."gateway_audience" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing"."gateway_audience" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "billing"."gateway_audience";
CREATE POLICY tenant_isolation ON "billing"."gateway_audience"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
DROP POLICY IF EXISTS cross_tenant ON "billing"."gateway_audience";
CREATE POLICY cross_tenant ON "billing"."gateway_audience"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."gateway_audience" TO txnet_app, txnet_cross_tenant;
