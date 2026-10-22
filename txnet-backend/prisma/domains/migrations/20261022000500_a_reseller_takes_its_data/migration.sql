-- A reseller can always take its data and leave (F-212-a, catalog §14.8).
--
-- `tenant.tenant_data_export` is one export its owner asked for: queued by the
-- request, built by worker-service's drain into one private archive on the
-- storage port, handed out only as a short-lived signed URL, and deleted when
-- it expires (the row stays, `expired`). At most one not-failed request per
-- 24 h — held by `TenantDataExportService` under the tenant row's lock, not by
-- a constraint, because a time window is not a unique key.
--
-- The request and each delivery are audit rows (`tenant_data_export_request`,
-- `tenant_data_export_delivery` on target `tenant_data_export`): §14.8 asks
-- the delivery itself to be audited, and a URL carries no session to audit
-- later.
--
-- Additive only: a new enum, a new table, three enum values. The values are
-- not used in this migration, so `ADD VALUE` is safe inside its transaction.
--
-- Rollback: drop the table and `TenantDataExportStatus`; an enum value cannot
-- be dropped, and three unused ones harm nothing.

-- CreateEnum
CREATE TYPE "tenant"."TenantDataExportStatus" AS ENUM ('queued', 'building', 'ready', 'failed', 'expired');

-- AlterEnum
ALTER TYPE "audit"."AdminAction" ADD VALUE 'tenant_data_export_request';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'tenant_data_export_delivery';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE 'tenant_data_export';

-- CreateTable
CREATE TABLE "tenant"."tenant_data_export" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "status" "tenant"."TenantDataExportStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "objectKey" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "rowCount" INTEGER,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "tenant_data_export_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_data_export_tenantId_createdAt_idx" ON "tenant"."tenant_data_export"("tenantId", "createdAt" DESC);
CREATE INDEX "tenant_data_export_status_createdAt_idx" ON "tenant"."tenant_data_export"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "tenant"."tenant_data_export" ADD CONSTRAINT "tenant_data_export_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant data: strict, as every tenant-owned table (shape A). The drain finds
-- work on the cross-tenant pool; everything else runs in the tenant's scope.
ALTER TABLE "tenant"."tenant_data_export" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant"."tenant_data_export" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant"."tenant_data_export" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "tenant"."tenant_data_export"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "tenant"."tenant_data_export"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
