-- F-311-ad (D-63) — a reseller's admin moves many configs to one panel as a
-- job: every live config on a source panel, or every live config of a list of
-- users. The configs that matched at the confirm are the job's items, so the
-- count the admin confirmed is what is moved. The worker moves them in batches
-- through `ConfigActions.move`, the single move's own act and audit row.
--
-- Tenant-scoped RLS on both, as every tenant table; the drain is cross-tenant
-- and reads through `txnet_cross_tenant`. Two audit actions and a target type
-- for the job's start and cancel.
--
-- Additive; rollback: remove the two tables and the status type. The enum
-- values added to "audit" cannot be removed and are harmless unused.

ALTER TYPE "audit"."AdminAction" ADD VALUE 'config_move_start';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'config_move_cancel';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE 'config_move_job';

CREATE TYPE "network"."ConfigMoveJobStatus" AS ENUM ('running', 'done', 'cancelled');

CREATE TABLE "network"."config_move_job" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "actorUserId" UUID NOT NULL,
    "actorIp" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" JSONB NOT NULL,
    "toPanelId" UUID NOT NULL,
    "status" "network"."ConfigMoveJobStatus" NOT NULL DEFAULT 'running',
    "total" INTEGER NOT NULL,
    "okCount" INTEGER NOT NULL DEFAULT 0,
    "refusedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),

    CONSTRAINT "config_move_job_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "config_move_job_tenantId_requestId_key" ON "network"."config_move_job"("tenantId", "requestId");
CREATE INDEX "config_move_job_tenantId_createdAt_idx" ON "network"."config_move_job"("tenantId", "createdAt");
-- What the drain scans: only running jobs, oldest first.
CREATE INDEX "config_move_job_running_idx" ON "network"."config_move_job"("createdAt") WHERE "status" = 'running';

CREATE TABLE "network"."config_move_job_item" (
    "jobId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "configId" UUID NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "doneAt" TIMESTAMP(3),
    "ok" BOOLEAN,
    "reason" TEXT,
    "movedTo" UUID,

    CONSTRAINT "config_move_job_item_pkey" PRIMARY KEY ("jobId", "configId"),
    CONSTRAINT "config_move_job_item_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "network"."config_move_job"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The drain's next batch of a job: its items with no outcome yet.
CREATE INDEX "config_move_job_item_pending_idx" ON "network"."config_move_job_item"("jobId", "configId") WHERE "doneAt" IS NULL;
-- The outcomes page: a job's done items in the order they were done.
CREATE INDEX "config_move_job_item_done_idx" ON "network"."config_move_job_item"("jobId", "doneAt") WHERE "doneAt" IS NOT NULL;

ALTER TABLE network.config_move_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.config_move_job FORCE ROW LEVEL SECURITY;
ALTER TABLE network.config_move_job_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.config_move_job_item FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "network"."config_move_job", "network"."config_move_job_item" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "network"."config_move_job"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "network"."config_move_job"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

CREATE POLICY tenant_isolation ON "network"."config_move_job_item"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "network"."config_move_job_item"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
