-- F-018-f (D-42 (1), ADR-0057) — what a tenant's status allows.
--
-- 1. `tenant.suspendedAt` / `graceEndsAt`: when a suspension started and until
--    when `/sub` is still served.
-- 2. `tenant_status_history`: every status change, append-only — a trigger
--    refuses UPDATE and DELETE, and the FK is RESTRICT because tenants are
--    never deleted ("nothing deleted"). Strict RLS, as every tenant-owned table.
-- 3. `tenant_subscription_setting.suspensionHoldDays` (default 7, 0..90).
-- 4. A NOTIFY on `tenant_status_changed` whenever a tenant's status or
--    `graceEndsAt` changes, so auth-service rewrites `tenant:status:<id>` in
--    Redis at once (F-101-b's pattern). The payload carries the id only.
-- 5. The audit value `tenant_status_change`.
--
-- Rollback: drop the triggers, the two functions, the table, the three
-- columns. The enum value stays, unused.

ALTER TABLE "tenant"."tenant" ADD COLUMN "suspendedAt" TIMESTAMP(3),
                              ADD COLUMN "graceEndsAt" TIMESTAMP(3);

CREATE TABLE "tenant"."tenant_status_history" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "fromStatus" "tenant"."TenantStatus" NOT NULL,
    "toStatus" "tenant"."TenantStatus" NOT NULL,
    "reason" TEXT,
    "actorUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_status_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tenant_status_history_tenantId_createdAt_idx" ON "tenant"."tenant_status_history"("tenantId", "createdAt" DESC);

ALTER TABLE "tenant"."tenant_status_history" ADD CONSTRAINT "tenant_status_history_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION tenant.refuse_status_history_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tenant_status_history is append-only';
END
$$;

CREATE TRIGGER tenant_status_history_append_only
  BEFORE UPDATE OR DELETE ON tenant.tenant_status_history
  FOR EACH ROW EXECUTE FUNCTION tenant.refuse_status_history_change();

ALTER TABLE tenant.tenant_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.tenant_status_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.tenant_status_history
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON tenant.tenant_status_history
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

ALTER TABLE "tenant"."tenant_subscription_setting"
  ADD COLUMN "suspensionHoldDays" INTEGER NOT NULL DEFAULT 7,
  ADD CONSTRAINT "tenant_subscription_setting_hold_days_range" CHECK ("suspensionHoldDays" BETWEEN 0 AND 90);

CREATE OR REPLACE FUNCTION tenant.notify_tenant_status_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'tenant_status_changed',
    json_build_object('tenantId', NEW.id)::text
  );
  RETURN NULL;
END
$$;

CREATE TRIGGER tenant_status_changed
  AFTER INSERT OR UPDATE OF status, "graceEndsAt" ON tenant.tenant
  FOR EACH ROW EXECUTE FUNCTION tenant.notify_tenant_status_changed();

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'tenant_status_change';
