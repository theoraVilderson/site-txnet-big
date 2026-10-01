-- F-019-v5 (ADR-0107 point 3, user 2026-10-01): a platform product is sellable
-- by a reseller only if its package lists it. A reseller with no subscription
-- sells none of the platform's; its own products are never listed here and
-- never bounded by it.
--
--   package_product — one row per (package, platform product). No tenant, no
--                     RLS (as tenant_feature_package). Goes with its package
--                     and with its product (a product removed is no longer
--                     listed; a listing never keeps a product from removal).
--
-- Every package existing now lists every platform product existing now (user,
-- 2026-10-01), so no reseller's sales stop on the day this applies; the
-- platform owner then narrows each list. A product made later is sold by no
-- package until one lists it.
--
-- Additive; rollback: DROP TABLE "tenant"."package_product".
-- (Enum values cannot be dropped; unused they are harmless.)

ALTER TYPE "audit"."AdminAction" ADD VALUE 'package_product_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'package_product_clear';

CREATE TABLE "tenant"."package_product" (
    "packageId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "package_product_pkey" PRIMARY KEY ("packageId", "productId")
);

CREATE INDEX "package_product_productId_idx" ON "tenant"."package_product"("productId");

ALTER TABLE "tenant"."package_product" ADD CONSTRAINT "package_product_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "tenant"."tenant_feature_package"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant"."package_product" ADD CONSTRAINT "package_product_productId_fkey" FOREIGN KEY ("productId") REFERENCES "catalog"."product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only a platform product is listed: a reseller's own is its own business.
CREATE FUNCTION tenant.package_product_is_platform() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM catalog.product WHERE id = NEW."productId" AND "tenantId" IS NOT NULL) THEN
    RAISE EXCEPTION 'package_product_not_platform' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER package_product_is_platform BEFORE INSERT OR UPDATE ON tenant.package_product
  FOR EACH ROW EXECUTE FUNCTION tenant.package_product_is_platform();

-- Today's packages keep selling today's platform products; updatedByUserId
-- is the nil uuid: no person did this, the migration did.
INSERT INTO "tenant"."package_product" ("packageId", "productId", "updatedByUserId", "updatedAt")
SELECT p."id", pr."id", '00000000-0000-0000-0000-000000000000', CURRENT_TIMESTAMP
FROM "tenant"."tenant_feature_package" p
CROSS JOIN "catalog"."product" pr
WHERE pr."tenantId" IS NULL;
