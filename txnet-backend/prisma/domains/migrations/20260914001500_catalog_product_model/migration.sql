-- F-026-a (D-34, ADR-0049) — the catalog becomes the spec's product model.
-- Spec: `tools/spec.py --section 4.1` .. `4.3`, F-501, F-0601, F-0602.
-- Hand-written in part: Prisma cannot express a partial unique index, a
-- trigger or a policy.
--
-- 1. `service_plan` and `service_plan_promotion` go. The catalog is
--    `product_category` -> `product` -> `product_variant` -> `price`. Campaign
--    pricing comes back with F-503/F-505.
-- 2. `price` is history: a trigger refuses any update but `isActive`, and any
--    delete. Yesterday's invoice is computed at yesterday's price (F-0602).
-- 3. A product, a variant and a price carry their parent's tenant, held by a
--    trigger, so RLS reads each without a join. A tenant's product may sit in
--    the platform's shared category.
-- 4. A key or a SKU is unique inside a tenant (and once among platform rows).
-- 5. `billing.coupon_service_scope` names exactly one product or one variant.
-- 6. `network.config.servicePlanId` goes; F-026-b gives a config its Grant.
-- 7. RLS: the three new tables are shared-read, as `product_category` already
--    is — `NULL OR mine` to read, strictly mine to write.
--
-- Nothing is migrated: no service ever wrote a plan, a scope or a config. The
-- guard below refuses to run over rows this would orphan rather than guess.
--
-- Rollback: restore the two tables, `ServicePlanBillingModel`, the scope's and
-- the config's plan columns and FKs, `product_category.name` and its global
-- unique key; drop the three tables, four enums, two functions and indexes.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM catalog.service_plan) THEN
    RAISE EXCEPTION 'catalog.service_plan has rows; F-026-a drops the table and has nowhere to move them';
  END IF;
  IF EXISTS (SELECT 1 FROM billing.coupon_service_scope) THEN
    RAISE EXCEPTION 'billing.coupon_service_scope has rows naming a plan or a category; F-026-a would widen those coupons to every purchase';
  END IF;
  IF EXISTS (SELECT 1 FROM network.config) THEN
    RAISE EXCEPTION 'network.config has rows; F-026-a drops the plan they name';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- The old catalog, and what pointed at it
-- -----------------------------------------------------------------------------
ALTER TABLE "billing"."coupon_service_scope"
  DROP CONSTRAINT "coupon_service_scope_servicePlanId_fkey",
  DROP CONSTRAINT "coupon_service_scope_categoryId_fkey",
  DROP COLUMN "servicePlanId",
  DROP COLUMN "categoryId",
  ADD COLUMN "productId" UUID,
  ADD COLUMN "variantId" UUID;

ALTER TABLE "network"."config"
  DROP CONSTRAINT "config_servicePlanId_fkey",
  DROP COLUMN "servicePlanId";

DROP TABLE "catalog"."service_plan_promotion";
DROP TABLE "catalog"."service_plan";
DROP TYPE "catalog"."ServicePlanBillingModel";

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
CREATE TYPE "catalog"."FulfilmentKind" AS ENUM ('network_access', 'external_order', 'feature_access', 'wallet_topup');
CREATE TYPE "catalog"."VariantVisibility" AS ENUM ('public', 'unlisted', 'admin_only');
CREATE TYPE "catalog"."VariantBillingMode" AS ENUM ('prepaid', 'metered');
CREATE TYPE "catalog"."QualityTier" AS ENUM ('standard', 'premium');

-- -----------------------------------------------------------------------------
-- product_category: a name key instead of text (§4.3), a key unique per tenant
-- -----------------------------------------------------------------------------
DROP INDEX "catalog"."product_category_key_key";

ALTER TABLE "catalog"."product_category"
  ADD COLUMN "nameKey" TEXT,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "catalog"."product_category" SET "nameKey" = 'catalog.category.' || "key" || '.name';
ALTER TABLE "catalog"."product_category"
  ALTER COLUMN "nameKey" SET NOT NULL,
  DROP COLUMN "name";

CREATE UNIQUE INDEX "product_category_tenant_key" ON "catalog"."product_category"("tenantId", "key") WHERE "tenantId" IS NOT NULL;
CREATE UNIQUE INDEX "product_category_platform_key" ON "catalog"."product_category"("key") WHERE "tenantId" IS NULL;

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
CREATE TABLE "catalog"."product" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "categoryId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "descriptionKey" TEXT,
    "fulfilmentKind" "catalog"."FulfilmentKind" NOT NULL,
    "featureKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "defaultQuotas" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "catalog"."product_variant" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "productId" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "nameKey" TEXT,
    "quotas" JSONB NOT NULL DEFAULT '{}',
    "durationDays" INTEGER,
    "billingMode" "catalog"."VariantBillingMode" NOT NULL,
    "visibility" "catalog"."VariantVisibility" NOT NULL,
    "panelGroupId" UUID,
    "qualityTier" "catalog"."QualityTier" NOT NULL DEFAULT 'standard',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_variant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_variant_duration_positive" CHECK ("durationDays" IS NULL OR "durationDays" > 0)
);

CREATE TABLE "catalog"."price" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "variantId" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_pkey" PRIMARY KEY ("id"),
    -- Zero is a free variant (a trial); below zero is never a price.
    CONSTRAINT "price_amount_not_negative" CHECK ("amount" >= 0)
);

CREATE INDEX "product_tenantId_idx" ON "catalog"."product"("tenantId");
CREATE INDEX "product_categoryId_idx" ON "catalog"."product"("categoryId");
CREATE UNIQUE INDEX "product_tenant_key" ON "catalog"."product"("tenantId", "key") WHERE "tenantId" IS NOT NULL;
CREATE UNIQUE INDEX "product_platform_key" ON "catalog"."product"("key") WHERE "tenantId" IS NULL;

CREATE INDEX "product_variant_tenantId_idx" ON "catalog"."product_variant"("tenantId");
CREATE INDEX "product_variant_productId_idx" ON "catalog"."product_variant"("productId");
CREATE UNIQUE INDEX "product_variant_tenant_sku" ON "catalog"."product_variant"("tenantId", "sku") WHERE "tenantId" IS NOT NULL;
CREATE UNIQUE INDEX "product_variant_platform_sku" ON "catalog"."product_variant"("sku") WHERE "tenantId" IS NULL;

CREATE INDEX "price_variantId_effectiveFrom_idx" ON "catalog"."price"("variantId", "effectiveFrom" DESC);
CREATE INDEX "price_tenantId_idx" ON "catalog"."price"("tenantId");

ALTER TABLE "catalog"."product" ADD CONSTRAINT "product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "catalog"."product_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "catalog"."product_variant" ADD CONSTRAINT "product_variant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "catalog"."product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "catalog"."price" ADD CONSTRAINT "price_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "catalog"."product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing"."coupon_service_scope" ADD CONSTRAINT "coupon_service_scope_productId_fkey" FOREIGN KEY ("productId") REFERENCES "catalog"."product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing"."coupon_service_scope" ADD CONSTRAINT "coupon_service_scope_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "catalog"."product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing"."coupon_service_scope" ADD CONSTRAINT "coupon_service_scope_names_one"
  CHECK (("productId" IS NULL) <> ("variantId" IS NULL));

-- -----------------------------------------------------------------------------
-- A child carries its parent's tenant
-- -----------------------------------------------------------------------------
CREATE FUNCTION catalog.same_tenant_as_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_tenant uuid;
BEGIN
  IF TG_TABLE_NAME = 'product' THEN
    SELECT "tenantId" INTO parent_tenant FROM catalog.product_category WHERE id = NEW."categoryId";
    -- The platform's shared category holds anyone's products; a tenant's holds only its own.
    IF FOUND AND (parent_tenant IS NULL OR parent_tenant IS NOT DISTINCT FROM NEW."tenantId") THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'product_variant' THEN
    SELECT "tenantId" INTO parent_tenant FROM catalog.product WHERE id = NEW."productId";
    IF FOUND AND parent_tenant IS NOT DISTINCT FROM NEW."tenantId" THEN
      RETURN NEW;
    END IF;
  ELSE
    SELECT "tenantId" INTO parent_tenant FROM catalog.product_variant WHERE id = NEW."variantId";
    IF FOUND AND parent_tenant IS NOT DISTINCT FROM NEW."tenantId" THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'catalog_tenant_mismatch: % % must carry its parent''s tenant', TG_TABLE_NAME, NEW.id
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER product_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "categoryId" ON "catalog"."product"
  FOR EACH ROW EXECUTE FUNCTION catalog.same_tenant_as_parent();
CREATE TRIGGER product_variant_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "productId" ON "catalog"."product_variant"
  FOR EACH ROW EXECUTE FUNCTION catalog.same_tenant_as_parent();
CREATE TRIGGER price_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "variantId" ON "catalog"."price"
  FOR EACH ROW EXECUTE FUNCTION catalog.same_tenant_as_parent();

-- -----------------------------------------------------------------------------
-- A price row is history (F-0602)
-- -----------------------------------------------------------------------------
CREATE FUNCTION catalog.price_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'price_is_history: a price row is never deleted; switch it off or write a new one'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW."variantId", NEW."tenantId", NEW."amount", NEW."effectiveFrom", NEW."createdByAdminId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."variantId", OLD."tenantId", OLD."amount", OLD."effectiveFrom", OLD."createdByAdminId", OLD."createdAt") THEN
    RAISE EXCEPTION 'price_is_history: only isActive changes on a price row; write a new one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER price_is_history BEFORE UPDATE OR DELETE ON "catalog"."price"
  FOR EACH ROW EXECUTE FUNCTION catalog.price_is_history();

-- -----------------------------------------------------------------------------
-- Row-Level Security: shared-read, as product_category
-- (20260909001500_row_level_security_all_tables, list B)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'catalog.product',
    'catalog.product_variant',
    'catalog.price'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);

    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);

    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END
$$;
