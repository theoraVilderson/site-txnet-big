-- F-307-x — a buyer's own name for a service (a Grant), user 2026-09-28.
--
-- Display only: My services, its search and the names a combined notice lists
-- show it before the config labels (F-307-f). Nothing is sent to a panel and
-- `/sub` does not read it. Null means the catalog's name.
--
-- The CHECK holds billing's rule at the storage edge, as `config_user_label_shape`
-- does for a config: trimmed, not empty (empty is null), at most 40 characters.
--
-- Additive, no backfill. Rollback: drop the constraint and the column.

ALTER TABLE "entitlement"."grant" ADD COLUMN "userLabel" TEXT;

ALTER TABLE "entitlement"."grant" ADD CONSTRAINT "grant_user_label_shape"
  CHECK ("userLabel" IS NULL OR ("userLabel" = btrim("userLabel") AND char_length("userLabel") BETWEEN 1 AND 40));
