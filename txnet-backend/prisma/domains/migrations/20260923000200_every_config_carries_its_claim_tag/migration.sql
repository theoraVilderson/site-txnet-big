-- F-027-aa — every config carries a claim tag.
--
-- The convergence pass finds a config's remote client by three keys, in order:
-- `remoteId`, `claimTag`, `uuid`. The tag is the one a rename on the panel
-- does not change, because it is written into a label we own; without it a
-- renamed client is a vanished one, its usage goes unattributed, and a user
-- whose config still works is cut off. A key that some rows lack is a key the
-- match cannot rely on, so the column is required rather than filled "when the
-- row has one". `ConfigActionsService.provision` writes it (`txn-` + 32 hex).
--
-- `network.config` has never held a row in production; the backfill exists for
-- development databases only. Rollback: drop the NOT NULL.

UPDATE "network"."config"
    SET "claimTag" = 'txn-' || replace(gen_random_uuid()::text, '-', '')
    WHERE "claimTag" IS NULL;

ALTER TABLE "network"."config" ALTER COLUMN "claimTag" SET NOT NULL;
