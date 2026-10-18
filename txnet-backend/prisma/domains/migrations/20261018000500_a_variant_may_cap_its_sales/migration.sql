-- F-513-a: a variant may be sold at most `salesCap` times (catalog F-513).
--
-- 1. `salesCap` null = no cap. `soldCount` and `reservedCount` are written by
--    billing through the catalog's counters (F-513-b): a pending invoice
--    reserves, payment sells, expiry/cancel/refund releases.
-- 2. No CHECK ties the counts to the cap: an admin may lower it under what is
--    sold (sales close, none is undone), and an admin or reseller issue is
--    counted past it (user, 2026-10-18).
-- Additive; rollback: drop the three columns.

ALTER TABLE "catalog"."product_variant"
    ADD COLUMN "salesCap" INTEGER,
    ADD COLUMN "soldCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "reservedCount" INTEGER NOT NULL DEFAULT 0,
    ADD CONSTRAINT "product_variant_sales_cap_positive" CHECK ("salesCap" IS NULL OR "salesCap" > 0),
    ADD CONSTRAINT "product_variant_sales_counts_not_negative" CHECK ("soldCount" >= 0 AND "reservedCount" >= 0);
