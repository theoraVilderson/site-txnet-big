-- F-307-f — a buyer's own name for a config (ADR-0089 rule 1).
--
-- Display only: billing's config list and `/sub` put it on a line's name as
-- they serve it. It is never written to a panel, where the client's name is
-- a matching key (F-027-aa) and a rename would read as drift. Null means the
-- default name (a template, evaluated per request, never stored here).
--
-- The CHECK holds billing's rule at the storage edge: trimmed, not empty
-- (empty is null, the default), at most 40 characters.
--
-- Additive, no backfill. Rollback: drop the constraint and the column.

ALTER TABLE "network"."config" ADD COLUMN "userLabel" TEXT;

ALTER TABLE "network"."config" ADD CONSTRAINT "config_user_label_shape"
  CHECK ("userLabel" IS NULL OR ("userLabel" = btrim("userLabel") AND char_length("userLabel") BETWEEN 1 AND 40));
