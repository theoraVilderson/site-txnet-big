-- F-026-h: a product nothing ever referenced can be deleted; a referenced one
-- is archived instead (catalog invariants 2, 2b and 6).
--
-- A price or a metered rate is still history: never deleted on its own, and
-- only `isActive` changes on it. It now goes with its variant — the variant's
-- delete cascades to it, and the trigger lets a row go once its variant is
-- gone. A variant a Grant, a coupon or a coupon scope references stays
-- undeletable (their foreign keys are RESTRICT), so a price anything was sold
-- at is never lost.

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_product_delete';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_product_archive';

ALTER TABLE "catalog"."product" ADD COLUMN "archivedAt" TIMESTAMP(3);

ALTER TABLE "catalog"."price" DROP CONSTRAINT "price_variantId_fkey";
ALTER TABLE "catalog"."price" ADD CONSTRAINT "price_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "catalog"."product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "catalog"."metered_rate" DROP CONSTRAINT "metered_rate_variantId_fkey";
ALTER TABLE "catalog"."metered_rate" ADD CONSTRAINT "metered_rate_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "catalog"."product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A cascaded delete runs after its variant's row is gone, so "the variant no
-- longer exists" is exactly "this delete is the variant's".
CREATE OR REPLACE FUNCTION catalog.price_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "catalog"."product_variant" WHERE "id" = OLD."variantId") THEN
      RAISE EXCEPTION 'price_is_history: a price row is never deleted; switch it off or write a new one'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
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

CREATE OR REPLACE FUNCTION catalog.metered_rate_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "catalog"."product_variant" WHERE "id" = OLD."variantId") THEN
      RAISE EXCEPTION 'metered_rate_is_history: a rate row is never deleted; switch it off or write a new one'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW."variantId", NEW."tenantId", NEW."rate", NEW."effectiveFrom", NEW."createdByAdminId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."variantId", OLD."tenantId", OLD."rate", OLD."effectiveFrom", OLD."createdByAdminId", OLD."createdAt") THEN
    RAISE EXCEPTION 'metered_rate_is_history: only isActive changes on a rate row; write a new one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
