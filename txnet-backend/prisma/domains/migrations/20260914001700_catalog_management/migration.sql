-- F-026-d (D-34, ADR-0049) — what catalog management needs in storage.
--
-- 1. Eight `AdminAction` values, so every catalog write leaves an audit row
--    naming what it did. Nothing is deleted, so there is no delete value; a
--    price has two, because a new price and a switched-off one are opposite
--    acts on what an invoice is computed at.
-- 2. Four `AuditTargetType` values: the category, product, variant or price a
--    row is about. A price is its own target because it is written as history.
-- 3. The `catalog.manage` permission, granted to `Admin` as `coupon.manage` is
--    (20260914000900). `prisma/seed.js` makes the same grant.
--
-- Rollback: delete the `role_permission` rows and the permission. Postgres
-- cannot drop an enum value; the twelve stay, unused.

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_category_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_category_update';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_product_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_product_update';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_variant_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_variant_update';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_price_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_price_deactivate';

ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'product_category';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'product';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'product_variant';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'price';

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'catalog.manage')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'catalog.manage'
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;
