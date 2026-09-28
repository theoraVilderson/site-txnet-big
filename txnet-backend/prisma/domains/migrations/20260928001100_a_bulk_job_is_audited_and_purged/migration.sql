-- F-311-u3: a bulk job by filter (F-311-u2) is audited as one admin act, and
-- its per-Grant rows are purged 30 days after it ends.
--
-- `grant_bulk_start` / `grant_bulk_cancel` against the new target type
-- `grant_bulk_job`: one `admin_audit_log` row each, in the start's and the
-- cancel's own transaction. Each Grant it acted on keeps its own row, as ever.
--
-- `purgedAt`: set when the job's items and its `grant_bulk_outcome` rows were
-- deleted. The job row and its counts are kept for good. The partial index is
-- what the purge scans: ended jobs not yet purged, oldest first.
--
-- Additive; rollback: DROP INDEX "billing"."grant_bulk_job_purge_due_idx",
-- "billing"."grant_bulk_outcome_createdAt_idx"; ALTER TABLE
-- "billing"."grant_bulk_job" DROP COLUMN "purgedAt" (enum values stay).

ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_bulk_start';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_bulk_cancel';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE 'grant_bulk_job';

ALTER TABLE "billing"."grant_bulk_job" ADD COLUMN "purgedAt" TIMESTAMP(3);

CREATE INDEX "grant_bulk_job_purge_due_idx" ON "billing"."grant_bulk_job"("finishedAt")
  WHERE "purgedAt" IS NULL AND "finishedAt" IS NOT NULL;

-- A bulk by id's outcomes have no job to purge them with; they go by age.
CREATE INDEX "grant_bulk_outcome_createdAt_idx" ON "billing"."grant_bulk_outcome"("createdAt");
