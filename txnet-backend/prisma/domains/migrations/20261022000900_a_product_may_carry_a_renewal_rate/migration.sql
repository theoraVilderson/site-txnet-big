-- F-305-b (ADR-0158 (4)-(6)): a product's renewal rate — what the GiB and days
-- a user types on their own Grant cost, within how few and how many.
--
-- 1. History, as `price` and the costs: a change is a new row from
--    `effectiveFrom`; no row is changed, and one is deleted only with its
--    product (cascade).
-- 2. Switching custom renewal off is a row with no prices and no bounds
--    (ADR-0151's take-back): `renewal_rate_off_whole` keeps a row whole either way.
-- 3. A part not sold has a maximum of 0; a sold part costs more than 0 — a rate of
--    0 would be a gift through the shop (ADR-0158, "Alternatives rejected").
-- 4. Its product's tenant, by the composite key `product_audience` already uses.
-- 5. Shared read, as every catalog row a buyer is priced by (catalog invariant 4).
-- Additive: one new table, no reader before F-305-e.
-- Rollback: drop the table and the function; the enum values stay (unused).

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_renewal_rate_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_renewal_rate_off';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'renewal_rate';

CREATE TABLE "catalog"."renewal_rate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "pricePerGib" DECIMAL(18,8),
    "pricePerDay" DECIMAL(18,8),
    "minGib" INTEGER,
    "maxGib" INTEGER,
    "minDays" INTEGER,
    "maxDays" INTEGER,
    "currencyCode" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "renewal_rate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "renewal_rate_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$'),
    CONSTRAINT "renewal_rate_off_whole" CHECK (
      num_nulls("pricePerGib", "pricePerDay", "minGib", "maxGib", "minDays", "maxDays") IN (0, 6)),
    CONSTRAINT "renewal_rate_bounds_ok" CHECK (
      "minGib" >= 0 AND "maxGib" >= "minGib" AND "minDays" >= 0 AND "maxDays" >= "minDays"),
    CONSTRAINT "renewal_rate_sells_something" CHECK ("maxGib" > 0 OR "maxDays" > 0),
    CONSTRAINT "renewal_rate_sold_part_priced" CHECK (
      ("maxGib" = 0 OR "pricePerGib" > 0) AND ("maxDays" = 0 OR "pricePerDay" > 0)
      AND "pricePerGib" >= 0 AND "pricePerDay" >= 0)
);
CREATE INDEX "renewal_rate_productId_effectiveFrom_idx" ON "catalog"."renewal_rate"("productId", "effectiveFrom" DESC);
CREATE INDEX "renewal_rate_tenantId_idx" ON "catalog"."renewal_rate"("tenantId");
ALTER TABLE "catalog"."renewal_rate" ADD CONSTRAINT "renewal_rate_productId_tenantId_fkey"
  FOREIGN KEY ("productId", "tenantId") REFERENCES "catalog"."product"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- A rate is history: never changed; deleted only by its product's cascade.
CREATE FUNCTION catalog.renewal_rate_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "catalog"."product" WHERE "id" = OLD."productId") THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'renewal_rate_is_history: a renewal rate is never changed or deleted; write a new one'
    USING ERRCODE = '23514';
END
$$;
CREATE TRIGGER renewal_rate_is_history BEFORE UPDATE OR DELETE ON "catalog"."renewal_rate"
  FOR EACH ROW EXECUTE FUNCTION catalog.renewal_rate_is_history();

-- Row-Level Security: shared read, as `price` (20261013000200).
ALTER TABLE "catalog"."renewal_rate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."renewal_rate" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "catalog"."renewal_rate" TO txnet_app, txnet_cross_tenant;
CREATE POLICY tenant_isolation ON "catalog"."renewal_rate"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id() OR "tenantId" = public.platform_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "catalog"."renewal_rate"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant USING (true) WITH CHECK (true);
