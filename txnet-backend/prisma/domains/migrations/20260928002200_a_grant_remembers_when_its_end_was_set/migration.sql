-- F-601-r (ADR-0097 part 1): an end notice is told only when it is news — a
-- level of L days only if L is at most half the span from when the end was
-- set to the end. `endSetAt` is that moment: issue, a renewal, an admin's days.
--
-- Backfill: the latest renewal or duration change that left the current end,
-- else `startsAt`, the instant the issued end was computed from. Every
-- renewal so far is an admin's (`grant_renewal`); a permanent Grant stays null.
--
-- Additive; rollback: drop the column, nothing else reads it.

ALTER TABLE "entitlement"."grant" ADD COLUMN "endSetAt" TIMESTAMP(3);

UPDATE "entitlement"."grant" g
SET "endSetAt" = COALESCE(
  (SELECT max(m.at) FROM (
     SELECT r."createdAt" AS at FROM "entitlement"."grant_renewal" r WHERE r."grantId" = g."id" AND r."endsAtAfter" = g."endsAt"
     UNION ALL
     SELECT d."createdAt" FROM "entitlement"."grant_duration_change" d WHERE d."grantId" = g."id" AND d."endsAtAfter" = g."endsAt"
   ) m),
  g."startsAt")
WHERE g."endsAt" IS NOT NULL;
