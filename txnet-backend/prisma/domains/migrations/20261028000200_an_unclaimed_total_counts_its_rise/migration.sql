-- LIVE-1-z (2026-10-28): a cumulative panel reports an unclaimed client's
-- running total each pass, and the consumer added it whole, so a 12 GiB
-- client read 12 TiB on chill-sanaee. The row now keeps the last total it was
-- given; the next one adds only its rise (a fall is a reset, counted whole).
-- Additive columns, default 0.
--
-- The open rows on panels that report totals hold a sum of totals that no
-- figure can be recovered from. They restart at zero with a zero cursor, so
-- the next pass writes the panel's own current total (user, 2026-10-28). Only
-- those rows' byte counts are rewritten; no row is deleted.
-- Rollback: drop the two columns (the reset figures are not restored).

ALTER TABLE "network"."unattributed_usage"
  ADD COLUMN "lastUpBytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "lastDownBytes" BIGINT NOT NULL DEFAULT 0;

UPDATE "network"."unattributed_usage" AS u
   SET "upBytes" = 0, "downBytes" = 0
  FROM "network"."panel" AS p
 WHERE p."id" = u."panelId"
   AND u."state" = 'open'
   AND p."counterSemantics" <> 'reset_on_read';
