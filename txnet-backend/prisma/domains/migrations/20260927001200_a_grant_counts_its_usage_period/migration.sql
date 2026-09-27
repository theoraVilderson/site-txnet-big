-- F-601-d: usage thresholds — a prepaid Grant crossing 50 / 80 / 95 % of its
-- period's bytes is told once per level. Quota and Used stay cumulative across
-- a renewal (invariant 16), so the period's share is measured from
-- `usagePeriodFromBytes` (`consumedBytes` when the period opened) and the
-- period is named by `usagePeriodStartedAt` (null = `startsAt`). Existing
-- Grants start at 0 / null: their period is the one they were issued in.
--
-- Additive; rollback: drop the two columns, nothing else reads them.

ALTER TABLE "entitlement"."grant"
  ADD COLUMN "usagePeriodFromBytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "usagePeriodStartedAt" TIMESTAMP(3);
