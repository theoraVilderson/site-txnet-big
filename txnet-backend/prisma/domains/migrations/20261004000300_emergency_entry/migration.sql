-- F-117-d (ADR-0104 (5), D-57) — tier C: a platform staff member enters a
-- reseller without its consent, for an emergency. A permission of its own
-- (`tenant.emergency_access`, granted to no role here: `*` holds it, anyone
-- else is given it by hand), a reason of at least 20 characters, exactly one
-- hour, no extension. Opening and an early end are `admin_audit_log` rows; the
-- owner is told by an outbox event in the same transaction.
--
-- Additive. Rollback: DROP the table and the permission row; the enum values
-- stay (Postgres cannot drop one) and are inert.

ALTER TYPE "audit"."AdminAction" ADD VALUE 'emergency_entry_open';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'emergency_entry_end';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE 'emergency_entry';

CREATE TABLE "audit"."emergency_access_entry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emergency_access_entry_pkey" PRIMARY KEY ("id"),
    -- The hard cap (ADR-0104 (5)): one hour, never more.
    CONSTRAINT "emergency_access_entry_hour" CHECK ("expiresAt" = "startedAt" + INTERVAL '1 hour'),
    CONSTRAINT "emergency_access_entry_reason" CHECK (char_length("reason") BETWEEN 20 AND 500),
    CONSTRAINT "emergency_access_entry_end" CHECK (("endedAt" IS NULL) = ("endedByUserId" IS NULL))
);

CREATE INDEX "emergency_access_entry_tenantId_startedAt_idx" ON "audit"."emergency_access_entry"("tenantId", "startedAt" DESC);

ALTER TABLE audit.emergency_access_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.emergency_access_entry FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON audit.emergency_access_entry TO txnet_app, txnet_cross_tenant;
CREATE POLICY tenant_isolation ON audit.emergency_access_entry AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id()) WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON audit.emergency_access_entry AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'tenant.emergency_access')
ON CONFLICT (key) DO NOTHING;
