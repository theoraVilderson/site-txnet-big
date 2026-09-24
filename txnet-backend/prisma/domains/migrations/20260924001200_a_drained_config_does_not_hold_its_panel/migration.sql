-- F-027-bp — a panel drained and later re-added to its group is placed again
-- for the Grants it was drained from (network `contract.groups.md` rule 9).
--
-- 1. `config.drainedAt`: set by the drain's retire (F-027-bm) and by nothing
--    else. A retired row still covers its panel for fulfilment — a user's
--    delete or move is a decision a refill would undo — except one the drain
--    retired: that was the platform emptying a panel, not the user choosing.
--    CHECK: only a retired row carries it.
-- 2. `config_group_panel_once` excludes drained rows, so the new placement can
--    stand beside the old retired one. Two concurrent runs still collide on
--    the new rows, which carry no `drainedAt`.
--
-- No config is drained on dev, so the CHECK validates against nothing and the
-- rebuilt index holds the same rows. Rollback: recreate the index without the
-- `drainedAt` term (refused while a Grant has a drained and a live row on one
-- panel), then drop the CHECK and the column.

-- AlterTable
ALTER TABLE "network"."config" ADD COLUMN "drainedAt" TIMESTAMP(3);

ALTER TABLE "network"."config"
  ADD CONSTRAINT "config_drained_is_retired" CHECK ("drainedAt" IS NULL OR "status" = 'retired');

-- CreateIndex
DROP INDEX "network"."config_group_panel_once";
CREATE UNIQUE INDEX "config_group_panel_once" ON "network"."config"("grantId", "panelId") WHERE "credentialGroupId" IS NOT NULL AND "drainedAt" IS NULL;
