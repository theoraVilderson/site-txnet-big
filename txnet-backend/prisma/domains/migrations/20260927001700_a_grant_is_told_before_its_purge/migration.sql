-- F-601-j: a suspended Grant is told a day before its purge (F-027-y).
-- `purgeNoticeFor` is the `suspendedAt` that notice was told for; the purge
-- sweep's hourly scan skips a Grant whose clock matches its suspension. A
-- revival clears `suspendedAt`, so the next suspension is armed by itself.
-- No index: the scan rides `grant_status_suspendedAt_idx`, as the purge does.
--
-- Additive; rollback: drop the column, nothing else reads it.

ALTER TABLE "entitlement"."grant"
  ADD COLUMN "purgeNoticeFor" TIMESTAMP(3);
