-- F-035-d — a campaign fans out on the worker.
--
-- `sendStartedAt` fixes the audience in time: a user registered after the send
-- started is not a recipient. `fanOutCursor` is the last `user.id` a committed
-- batch covered, written in that batch's transaction, so a crashed run resumes
-- where it stopped. `fannedOutAt` marks the audience fully written.
-- The unique index is what makes a re-run insert nothing (invariant 4).
-- `notification_campaign_recipient` has always been empty — nothing wrote it
-- before this row — so the index cannot meet a duplicate.
--
-- Rollback: drop the index and the three columns; enum values stay (Postgres
-- cannot drop one).

ALTER TABLE "notification"."notification_campaign"
  ADD COLUMN "sendStartedAt" TIMESTAMP(3),
  ADD COLUMN "fanOutCursor" UUID,
  ADD COLUMN "fannedOutAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "notification_campaign_recipient_campaignId_userId_key"
  ON "notification"."notification_campaign_recipient" ("campaignId", "userId");

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'campaign_send';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'notification_campaign';
