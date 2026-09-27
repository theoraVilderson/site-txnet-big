-- F-602: exhaustion forecast — "at this rate, your volume runs out in N days",
-- told once per usage period. `forecastNoticeFor` is the period
-- (`usagePeriodStartedAt ?? startsAt`) it was told for. No index: the sweep's
-- candidates come off `grant_status_idleCheckAt_idx` (used in the last 72 h).
--
-- Additive; rollback: drop the column, nothing else reads it.

ALTER TABLE "entitlement"."grant"
  ADD COLUMN "forecastNoticeFor" TIMESTAMP(3);
