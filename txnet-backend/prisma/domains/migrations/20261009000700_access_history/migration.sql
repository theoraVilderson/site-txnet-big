-- AC-1-p: access history. One `audit.access_history` row per person whose
-- access an act moved, written beside their `access.changed` event in the act's
-- transaction (`recordAccessChange`, shared-core). It points at the act's
-- `admin_audit_log` row, which says who, before, after and why.
--
-- The acts that wrote no audit row get one: a role's keys replaced, and a staff
-- seat invited, its end moved, removed.
--
-- Additive. Rollback: DROP the table; the enum values stay (Postgres cannot
-- drop one) and are inert. History is not backfilled: acts before this
-- migration are in `admin_audit_log` alone.

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'role_keys_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'staff_seat_invite';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'staff_seat_end_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'staff_seat_remove';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'role';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'staff_seat';

CREATE TABLE "audit"."access_history" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "cause" TEXT NOT NULL,
    "auditLogId" UUID,
    "given" TEXT[],
    "taken" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "access_history_tenantId_userId_createdAt_idx" ON "audit"."access_history"("tenantId", "userId", "createdAt" DESC);
CREATE INDEX "access_history_auditLogId_idx" ON "audit"."access_history"("auditLogId");

-- Strict, as `emergency_access_entry`: every writer binds the act's tenant
-- (`tenantTransaction`) or is the cross-tenant pool (tenant-service's seats).
-- Append-only: no UPDATE or DELETE is granted.
ALTER TABLE audit.access_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.access_history FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON audit.access_history TO txnet_app, txnet_cross_tenant;
CREATE POLICY tenant_isolation ON audit.access_history AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id()) WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON audit.access_history AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
