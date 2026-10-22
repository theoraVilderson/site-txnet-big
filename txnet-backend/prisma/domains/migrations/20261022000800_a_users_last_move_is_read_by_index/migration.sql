-- F-410-b — `GET …/configs/:id/move-targets` answers `nextMoveAt`: the Grant's
-- last move by its own user plus the wait in effect. That is the newest
-- `move_out` row of `actorType` `user` over the Grant's configs, and
-- `config_action_log` had no index on `configId` at all — every read was a
-- sequential scan of a table that gains a row per action on every config.
--
-- Additive; rollback: drop the index. Built without CONCURRENTLY, as Prisma
-- runs a migration in a transaction: writes to the table wait for the build
-- (150 rows on dev, 2026-10-22).

CREATE INDEX "config_action_log_configId_createdAt_idx" ON "network"."config_action_log"("configId", "createdAt");
