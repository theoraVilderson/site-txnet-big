-- F-1533-f (ADR-0050 amendment 2) — each catalog item has a source language.
--
-- The language an admin wrote a category's or product's name in; machine
-- drafts are translated from it, and a reader falls back to it. Nullable: a
-- row from before this reads as DEFAULT_LANGUAGE, which is deployment data,
-- so no language is written here (§1.1). Which languages exist is
-- locale-service's answer, checked by billing; the CHECK only holds the shape.
--
-- Rollback: drop the two columns.

ALTER TABLE "catalog"."product_category" ADD COLUMN "sourceLang" TEXT;
ALTER TABLE "catalog"."product" ADD COLUMN "sourceLang" TEXT;

ALTER TABLE "catalog"."product_category"
  ADD CONSTRAINT "product_category_source_lang_shape" CHECK ("sourceLang" IS NULL OR "sourceLang" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$');
ALTER TABLE "catalog"."product"
  ADD CONSTRAINT "product_source_lang_shape" CHECK ("sourceLang" IS NULL OR "sourceLang" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$');
