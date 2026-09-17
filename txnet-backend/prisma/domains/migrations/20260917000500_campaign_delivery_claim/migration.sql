-- F-035-e — a campaign delivers to Telegram and Bale.
--
-- `claimedUntil` is a delivery run's lease on a `queued` row: a run claims rows
-- whose lease is null or past (`FOR UPDATE SKIP LOCKED`), so two overlapping
-- runs never send the same row, and a run that crashed mid-send gives its rows
-- back when the lease runs out. A rate-limited row is released with its lease
-- set to the platform's `retry_after`.
--
-- Rollback: drop the column.

ALTER TABLE "notification"."notification_campaign_recipient"
  ADD COLUMN "claimedUntil" TIMESTAMP(3);
