-- F-117-a (ADR-0104 (4), D-57, catalog §3.7) — the platform reaches a
-- reseller's people only under a time-bound consent the reseller grants:
--   * `support_access_consent`: a request (platform staff), a grant (the
--     reseller's owner or a `tenant.manage` seat), its revoke — scope `read` or
--     `act`, at most 24 hours;
--   * `support_consent_policy`: the reseller's default length (no row = 4 h).
-- Each boundary is an `admin_audit_log` row in the reseller's own trail.
--
-- Additive. Rollback: DROP both tables and the enum; the AdminAction /
-- AuditTargetType values stay (Postgres cannot drop one) and are inert.

ALTER TYPE "audit"."AdminAction" ADD VALUE 'support_consent_request';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'support_consent_grant';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'support_consent_revoke';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'support_consent_policy_set';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE 'support_consent';

CREATE TYPE "audit"."SupportConsentScope" AS ENUM ('read', 'act');

CREATE TABLE "audit"."support_access_consent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "scope" "audit"."SupportConsentScope" NOT NULL,
    "reason" TEXT,
    "requestedByUserId" UUID,
    "requestedAt" TIMESTAMP(3),
    "grantedByUserId" UUID,
    "grantedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedByUserId" UUID,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_access_consent_pkey" PRIMARY KEY ("id"),
    -- A request names its asker; a grant names its granter and its end, together.
    CONSTRAINT "support_access_consent_request" CHECK (("requestedAt" IS NULL) = ("requestedByUserId" IS NULL)),
    CONSTRAINT "support_access_consent_grant" CHECK (
      ("grantedAt" IS NULL) = ("grantedByUserId" IS NULL) AND ("grantedAt" IS NULL) = ("expiresAt" IS NULL)),
    CONSTRAINT "support_access_consent_origin" CHECK ("requestedAt" IS NOT NULL OR "grantedAt" IS NOT NULL),
    -- The hard cap (catalog §3.7): no grant outlives 24 hours.
    CONSTRAINT "support_access_consent_cap" CHECK (
      "expiresAt" IS NULL OR ("expiresAt" > "grantedAt" AND "expiresAt" <= "grantedAt" + INTERVAL '24 hours')),
    CONSTRAINT "support_access_consent_reason" CHECK ("reason" IS NULL OR char_length("reason") <= 500)
);

CREATE INDEX "support_access_consent_tenantId_createdAt_idx" ON "audit"."support_access_consent"("tenantId", "createdAt" DESC);
-- One open request per reseller at a time.
CREATE UNIQUE INDEX "support_access_consent_one_request" ON "audit"."support_access_consent"("tenantId")
  WHERE "grantedAt" IS NULL AND "revokedAt" IS NULL;

CREATE TABLE "audit"."support_consent_policy" (
    "tenantId" UUID NOT NULL,
    "defaultHours" SMALLINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_consent_policy_pkey" PRIMARY KEY ("tenantId"),
    CONSTRAINT "support_consent_policy_hours" CHECK ("defaultHours" BETWEEN 1 AND 24)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit.support_access_consent', 'audit.support_consent_policy'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO txnet_app, txnet_cross_tenant', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL TO txnet_app
      USING ("tenantId" = public.current_tenant_id()) WITH CHECK ("tenantId" = public.current_tenant_id())$p$, t);
    EXECUTE format($p$CREATE POLICY cross_tenant ON %s AS PERMISSIVE FOR ALL TO txnet_cross_tenant
      USING (true) WITH CHECK (true)$p$, t);
  END LOOP;
END $$;
