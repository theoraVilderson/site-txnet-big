-- F-018-q — a campaign can be stopped with its reseller's suspension.
--
-- `stopped` halts a send without failing or deleting a row: the delivery run
-- claims only rows of `sending` campaigns, and the fan-out writes only for
-- `sending` ones, so the status alone halts both at their next run. Its
-- recipients stay `queued`; `POST .../resume` moves it back to `sending`.
-- `stoppedAt` records when.
--
-- Rollback: drop the column; enum values stay (Postgres cannot drop one).

ALTER TYPE "notification"."CampaignStatus" ADD VALUE IF NOT EXISTS 'stopped';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'campaign_resume';

ALTER TABLE "notification"."notification_campaign"
  ADD COLUMN "stoppedAt" TIMESTAMP(3);
