-- F-026-l: a category removed with its products is deleted when none of them
-- was sold, and archived when a sold one stays in it (catalog invariant 6).
-- `product.categoryId` stays RESTRICT, so an archived product keeps its category.

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_category_archive';

ALTER TABLE "catalog"."product_category" ADD COLUMN "archivedAt" TIMESTAMP(3);
