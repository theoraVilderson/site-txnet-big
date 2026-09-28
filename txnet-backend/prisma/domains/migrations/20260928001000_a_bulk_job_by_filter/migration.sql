-- F-311-u2: a bulk act on a reseller's Grants chosen by a filter (a panel, a
-- product or variant, statuses) instead of 1..50 ids, run by the worker in
-- batches. The Grants that matched at the confirm are the job's items — the
-- selection is frozen, so the count the admin confirmed is what is acted on.
--
-- Each Grant's outcome stays in `grant_bulk_outcome` under the job's
-- `requestId` (F-311-u1); an item only says it is done, or failed after its
-- last attempt. Tenant-scoped RLS on both, as every tenant table; the drain is
-- cross-tenant and reads through `txnet_cross_tenant`.
--
-- Additive; rollback: DROP TABLE "billing"."grant_bulk_job_item",
-- "billing"."grant_bulk_job"; DROP TYPE "billing"."GrantBulkJobStatus".

CREATE TYPE "billing"."GrantBulkJobStatus" AS ENUM ('running', 'done', 'cancelled');

CREATE TABLE "billing"."grant_bulk_job" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "actorUserId" UUID NOT NULL,
    "actorIp" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "command" JSONB NOT NULL,
    "filter" JSONB NOT NULL,
    "status" "billing"."GrantBulkJobStatus" NOT NULL DEFAULT 'running',
    "total" INTEGER NOT NULL,
    "okCount" INTEGER NOT NULL DEFAULT 0,
    "refusedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "grant_bulk_job_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "grant_bulk_job_tenantId_requestId_key" ON "billing"."grant_bulk_job"("tenantId", "requestId");
CREATE INDEX "grant_bulk_job_tenantId_createdAt_idx" ON "billing"."grant_bulk_job"("tenantId", "createdAt");
-- What the drain scans: only running jobs, oldest first.
CREATE INDEX "grant_bulk_job_running_idx" ON "billing"."grant_bulk_job"("createdAt") WHERE "status" = 'running';

CREATE TABLE "billing"."grant_bulk_job_item" (
    "jobId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "doneAt" TIMESTAMP(3),
    "ok" BOOLEAN,
    "failed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "grant_bulk_job_item_pkey" PRIMARY KEY ("jobId", "grantId"),
    CONSTRAINT "grant_bulk_job_item_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "billing"."grant_bulk_job"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The drain's next batch of a job: its items with no outcome yet.
CREATE INDEX "grant_bulk_job_item_pending_idx" ON "billing"."grant_bulk_job_item"("jobId", "grantId") WHERE "doneAt" IS NULL;
-- The outcomes page: a job's done items in the order they were done.
CREATE INDEX "grant_bulk_job_item_done_idx" ON "billing"."grant_bulk_job_item"("jobId", "doneAt") WHERE "doneAt" IS NOT NULL;

ALTER TABLE billing.grant_bulk_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.grant_bulk_job FORCE ROW LEVEL SECURITY;
ALTER TABLE billing.grant_bulk_job_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.grant_bulk_job_item FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."grant_bulk_job", "billing"."grant_bulk_job_item" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "billing"."grant_bulk_job"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "billing"."grant_bulk_job"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

CREATE POLICY tenant_isolation ON "billing"."grant_bulk_job_item"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "billing"."grant_bulk_job_item"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
