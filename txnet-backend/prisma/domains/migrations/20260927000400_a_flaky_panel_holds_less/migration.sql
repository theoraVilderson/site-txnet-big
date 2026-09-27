-- F-027-dh — a panel's outage history scales its MaxLease (SPEC weakness #21).
--
-- `quotaengine/schema.sql` kept `reliability real NOT NULL DEFAULT 1`. Here the
-- planner keeps what reliability is read from: a count of outages that halves
-- every day, as of the last one (`quota.Outages`). The decay is computed on
-- read, so the row moves only when an outage ends.
--
-- Additive: defaulted or nullable, and 0 reads as a panel with no outage, the
-- planner's figure before this row. Rollback: drop the columns and constraint.

ALTER TABLE "network"."panel" ADD COLUMN "outageWeight" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "network"."panel" ADD COLUMN "outageWeightAt" TIMESTAMP(3);

-- A weight is never negative, and dated exactly when there is one.
ALTER TABLE "network"."panel" ADD CONSTRAINT "panel_outage_weight_has_time" CHECK (
  "outageWeight" >= 0
  AND ("outageWeight" = 0) = ("outageWeightAt" IS NULL)
);
