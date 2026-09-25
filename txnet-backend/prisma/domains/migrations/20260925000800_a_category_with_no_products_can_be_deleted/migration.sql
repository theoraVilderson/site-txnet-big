-- F-026-j: a category no product sits in can be deleted (catalog invariant 6).
--
-- Nothing else changes: `product.categoryId` has been ON DELETE RESTRICT since
-- F-026-a, so a category holding any product, an archived one included, stays.
-- The delete is audited under its own action.

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_category_delete';
