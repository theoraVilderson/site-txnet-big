-- F-027-ab — the anti-flap stop counts repairs inside a window.
--
-- `driftRepairCount` alone is a count for ever: every config that is repaired
-- twice in its life, months apart and for unrelated reasons, would end
-- `contested`, and the operator's toil would grow with the number of tenants.
-- The stop counts only repairs within 24 hours of the one before (user,
-- 2026-09-23), so it needs the time of the last one. A count with no time is a
-- window nobody can compute, hence the CHECK.
--
-- Additive and nullable: no backfill. Rollback: drop the constraint and the
-- column.

ALTER TABLE "network"."config"
    ADD COLUMN "driftRepairedAt" TIMESTAMP(3);

ALTER TABLE "network"."config"
    ADD CONSTRAINT "config_drift_repair_has_a_time"
    CHECK ("driftRepairCount" = 0 OR "driftRepairedAt" IS NOT NULL);
