-- F-1001-q: a pass used to convert every cost row into the tenant's currency at
-- the time of the pass, so a tenant whose rollup was rewritten after a currency
-- change (F-116) holds earlier days' costs in the new money. Data only: the
-- rebuild flag is raised for every such tenant, and the next ticks rebuild its
-- whole history with each day in the currency it sold in (a flag left up is
-- always run again — analytics-rollup.service.ts). No row is deleted here; a
-- tenant never rolled has no state row and is rebuilt whole on its first tick.
-- Rollback: nothing to undo; the flag clears itself when the rebuild ends.

UPDATE "billing"."analytics_rollup_state" s
SET "rebuildingSince" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
WHERE s."rebuildingSince" IS NULL
  AND EXISTS (SELECT 1 FROM "billing"."currency_change" c WHERE c."tenantId" = s."tenantId");
