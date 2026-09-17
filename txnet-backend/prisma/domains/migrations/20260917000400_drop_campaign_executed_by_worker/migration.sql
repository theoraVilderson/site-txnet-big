-- Drops `notification_campaign.executedByBotWorkerId` (user, 2026-09-17).
--
-- It predates the worker runtime and assumed one worker runs a campaign. In
-- practice one job (`notification_campaign_fan_out`) fans every campaign out,
-- across several runs and replicas, and each run is already a
-- `bot_execution_log` row. Nothing ever wrote or read it — every row is NULL,
-- so no data is lost. It had no foreign key and no index.
--
-- Rollback: `ADD COLUMN "executedByBotWorkerId" UUID` (NULL everywhere, as before).

ALTER TABLE "notification"."notification_campaign" DROP COLUMN "executedByBotWorkerId";
