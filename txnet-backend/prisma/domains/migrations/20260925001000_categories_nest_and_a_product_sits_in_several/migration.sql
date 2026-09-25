-- F-026-q (user, 2026-09-25): a category may sit under another, and a product
-- is filed in one or more categories through a join table. `product.categoryId`
-- goes: the table is the only place a product's categories are read.
--
-- The depth is not capped here — that is one constant in code (F-026-r). A
-- cycle is refused here, under a transaction lock, because two concurrent
-- re-parents can each pass a check made in code and together close a loop.

-- -----------------------------------------------------------------------------
-- product_category.parentId
-- -----------------------------------------------------------------------------
ALTER TABLE "catalog"."product_category" ADD COLUMN "parentId" UUID;
ALTER TABLE "catalog"."product_category" ADD CONSTRAINT "product_category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "catalog"."product_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "product_category_parentId_idx" ON "catalog"."product_category"("parentId");

CREATE FUNCTION catalog.category_parent_ok() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_tenant uuid;
  cursor_id uuid;
  steps int := 0;
BEGIN
  IF NEW."parentId" IS NULL THEN
    RETURN NEW;
  END IF;
  -- One re-parent at a time: the walk below is only sound if no other
  -- transaction is moving a category while it runs.
  PERFORM pg_advisory_xact_lock(hashtext('catalog.category_tree'));

  SELECT "tenantId" INTO parent_tenant FROM catalog.product_category WHERE id = NEW."parentId";
  -- The platform's category holds anyone's children; a tenant's only its own.
  IF NOT FOUND OR NOT (parent_tenant IS NULL OR parent_tenant IS NOT DISTINCT FROM NEW."tenantId") THEN
    RAISE EXCEPTION 'catalog_tenant_mismatch: product_category % must sit under its tenant''s category or the platform''s', NEW.id
      USING ERRCODE = '23514';
  END IF;

  cursor_id := NEW."parentId";
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'category_cycle: product_category % would sit under itself', NEW.id
        USING ERRCODE = '23514';
    END IF;
    steps := steps + 1;
    IF steps > 1000 THEN
      RAISE EXCEPTION 'category_cycle: the tree above product_category % does not end', NEW.id
        USING ERRCODE = '23514';
    END IF;
    SELECT "parentId" INTO cursor_id FROM catalog.product_category WHERE id = cursor_id;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER product_category_parent_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "parentId" ON "catalog"."product_category"
  FOR EACH ROW EXECUTE FUNCTION catalog.category_parent_ok();

-- -----------------------------------------------------------------------------
-- product_category_link
-- -----------------------------------------------------------------------------
CREATE TABLE "catalog"."product_category_link" (
    "productId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "tenantId" UUID,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_category_link_pkey" PRIMARY KEY ("productId","categoryId")
);

CREATE INDEX "product_category_link_categoryId_idx" ON "catalog"."product_category_link"("categoryId");
CREATE INDEX "product_category_link_tenantId_idx" ON "catalog"."product_category_link"("tenantId");

ALTER TABLE "catalog"."product_category_link" ADD CONSTRAINT "product_category_link_productId_fkey" FOREIGN KEY ("productId") REFERENCES "catalog"."product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog"."product_category_link" ADD CONSTRAINT "product_category_link_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "catalog"."product_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariant 3, moved off `product`: the link carries its product's tenant, and
-- the category is the platform's or that tenant's.
CREATE FUNCTION catalog.category_link_ok() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  product_tenant uuid;
  category_tenant uuid;
BEGIN
  SELECT "tenantId" INTO product_tenant FROM catalog.product WHERE id = NEW."productId";
  IF FOUND AND product_tenant IS NOT DISTINCT FROM NEW."tenantId" THEN
    SELECT "tenantId" INTO category_tenant FROM catalog.product_category WHERE id = NEW."categoryId";
    IF FOUND AND (category_tenant IS NULL OR category_tenant IS NOT DISTINCT FROM NEW."tenantId") THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'catalog_tenant_mismatch: product_category_link %/% must carry its product''s tenant and a category it may sit in', NEW."productId", NEW."categoryId"
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER product_category_link_same_tenant BEFORE INSERT OR UPDATE ON "catalog"."product_category_link"
  FOR EACH ROW EXECUTE FUNCTION catalog.category_link_ok();

-- Every product keeps the category it had, as its first.
INSERT INTO "catalog"."product_category_link" ("productId", "categoryId", "tenantId", "position")
  SELECT id, "categoryId", "tenantId", 0 FROM "catalog"."product";

-- -----------------------------------------------------------------------------
-- product.categoryId goes
-- -----------------------------------------------------------------------------
DROP TRIGGER product_same_tenant ON "catalog"."product";
DROP INDEX "catalog"."product_categoryId_idx";
ALTER TABLE "catalog"."product" DROP CONSTRAINT "product_categoryId_fkey";
ALTER TABLE "catalog"."product" DROP COLUMN "categoryId";

-- The `product` branch read the dropped column; the link has its own trigger.
CREATE OR REPLACE FUNCTION catalog.same_tenant_as_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_tenant uuid;
BEGIN
  IF TG_TABLE_NAME = 'product_variant' THEN
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

-- -----------------------------------------------------------------------------
-- Row-Level Security: shared-read, as product_category
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'catalog.product_category_link'
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
