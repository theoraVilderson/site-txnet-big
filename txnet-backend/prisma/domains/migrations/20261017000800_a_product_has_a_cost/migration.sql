-- F-1002-d (ADR-0151): what a sale of a variant, and a unit of a meter, cost
-- a tenant — so a product with no panel stops reading as 100% margin.
--
-- 1. Shaped like `price` and `rate_card`, down to their triggers: a cost is
--    history, and a variant's cost carries its variant's tenant.
-- 2. Private to its tenant: no shared read, unlike every other catalog row.
--    A reseller must never learn what the platform pays its suppliers.
-- 3. `vpn.traffic` takes no unit cost: its cost is its panels' (ADR-0151 (3)).
-- Rollback: drop both tables and the function; the enum values stay (unused).

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_variant_cost_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_meter_cost_set';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'variant_cost';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'meter_cost';

CREATE TABLE "catalog"."variant_cost" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "variant_cost_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "variant_cost_amount_not_negative" CHECK ("amount" >= 0),
    CONSTRAINT "variant_cost_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$')
);
CREATE INDEX "variant_cost_variantId_effectiveFrom_idx" ON "catalog"."variant_cost"("variantId", "effectiveFrom" DESC);
CREATE INDEX "variant_cost_tenantId_idx" ON "catalog"."variant_cost"("tenantId");
ALTER TABLE "catalog"."variant_cost" ADD CONSTRAINT "variant_cost_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "catalog"."product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "catalog"."meter_cost" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "meterKey" TEXT NOT NULL,
    "unitSize" BIGINT NOT NULL,
    "unitCost" DECIMAL(18,8) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "meter_cost_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "meter_cost_unit_size_positive" CHECK ("unitSize" > 0),
    CONSTRAINT "meter_cost_unit_cost_not_negative" CHECK ("unitCost" >= 0),
    CONSTRAINT "meter_cost_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$'),
    CONSTRAINT "meter_cost_not_vpn_traffic" CHECK ("meterKey" <> 'vpn.traffic')
);
CREATE INDEX "meter_cost_tenantId_meterKey_effectiveFrom_idx" ON "catalog"."meter_cost"("tenantId", "meterKey", "effectiveFrom" DESC);
ALTER TABLE "catalog"."meter_cost" ADD CONSTRAINT "meter_cost_meterKey_fkey"
  FOREIGN KEY ("meterKey") REFERENCES "catalog"."meter"("key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A variant's cost carries its variant's tenant (invariant 3), as a price does.
CREATE TRIGGER variant_cost_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "variantId" ON "catalog"."variant_cost"
  FOR EACH ROW EXECUTE FUNCTION catalog.same_tenant_as_parent();

-- A cost is history (invariant 2c): never changed; deleted only by its variant's cascade.
CREATE FUNCTION catalog.cost_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Nested, not AND-ed: plpgsql does not short-circuit, and `meter_cost` has no "variantId".
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'variant_cost' THEN
    IF NOT EXISTS (SELECT 1 FROM "catalog"."product_variant" WHERE "id" = OLD."variantId") THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'cost_is_history: a cost row is never changed or deleted; write a new one'
    USING ERRCODE = '23514';
END
$$;
CREATE TRIGGER variant_cost_is_history BEFORE UPDATE OR DELETE ON "catalog"."variant_cost"
  FOR EACH ROW EXECUTE FUNCTION catalog.cost_is_history();
CREATE TRIGGER meter_cost_is_history BEFORE UPDATE OR DELETE ON "catalog"."meter_cost"
  FOR EACH ROW EXECUTE FUNCTION catalog.cost_is_history();

-- Row-Level Security: the tenant's own rows only — no `NULL`, no platform share.
ALTER TABLE "catalog"."variant_cost" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."variant_cost" FORCE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."meter_cost" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."meter_cost" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "catalog"."variant_cost", "catalog"."meter_cost" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "catalog"."variant_cost"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id()) WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "catalog"."variant_cost"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON "catalog"."meter_cost"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id()) WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "catalog"."meter_cost"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant USING (true) WITH CHECK (true);
