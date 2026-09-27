-- F-601-n: a non-urgent usage notice (50 / 80 %) is held on its Grant up to
-- 24 h for a time level, so two due the same day reach the user as one
-- message. `usageNoticeLevel` is the level held, `usageNoticeSince` when the
-- hold began; the hourly end sweep tells it when it is 24 h old.
--
-- Additive; rollback: drop the index and the two columns, nothing else reads them.

ALTER TABLE "entitlement"."grant"
  ADD COLUMN "usageNoticeLevel" INTEGER,
  ADD COLUMN "usageNoticeSince" TIMESTAMP(3);

CREATE INDEX "grant_status_usageNoticeSince_idx" ON "entitlement"."grant" ("status", "usageNoticeSince");
