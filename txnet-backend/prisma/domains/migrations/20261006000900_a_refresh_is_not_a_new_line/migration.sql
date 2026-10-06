-- F-027-en, contract.links.md rule 7 — a refresh that read the same lines is
-- not a new line.
--
-- `linksCapturedAt` is since when the served lines began: billing's drain
-- waits `2 × subscriptionTtlSeconds` from it (group-drain.ts,
-- replacementSince). The daily refresh (rule 6b) wrote it on every read, so a
-- refresh restarted every drain's wait. It now moves only when the lines or
-- the uuid change; `linksCheckedAt` is the last read, and a refresh is due
-- from it.
--
-- Additive. Backfilled from `linksCapturedAt`, the last read until now.
-- Rollback: drop the column.

ALTER TABLE "network"."config" ADD COLUMN "linksCheckedAt" TIMESTAMP(3);

UPDATE "network"."config" SET "linksCheckedAt" = "linksCapturedAt" WHERE "linksCapturedAt" IS NOT NULL;
