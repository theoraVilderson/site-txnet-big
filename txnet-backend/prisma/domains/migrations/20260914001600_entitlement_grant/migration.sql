-- F-026-b (D-34, ADR-0049) — the Grant's storage.
-- Spec: `tools/spec.py --section 4.4` .. `4.6`.
-- Hand-written in part: Prisma cannot express a trigger, a partial unique index
-- or a policy.
--
-- 1. A new Postgres schema, `entitlement`, granted as every domain schema is
--    (20260909000500_row_level_security).
-- 2. `grant` and `quota_adjustment` are strictly tenant-scoped — never
--    shared-read. A Grant's user is its tenant's; its variant is the
--    platform's or its tenant's; an adjustment and a config are their Grant's
--    tenant's (`entitlement_tenant_mismatch`).
-- 3. A Grant's status moves one way; only `suspended -> active` returns
--    (`grant_status_one_way`). An expired or exhausted Grant never revives.
-- 4. The subscription token is stored only as its SHA-256 in lowercase hex
--    (`grant_token_hash_shape`), unique across every Grant. The token is shown
--    once, at issue and on rotation (the user's call, 2026-09-14).
-- 5. One cause issues one Grant: `(source, sourceReferenceId)` is unique when set.
-- 6. A quota adjustment is history (`quota_adjustment_is_history`).
-- 7. `network.config.grantId`: a config draws on its Grant's quota (§4.6).
--    Refused over existing config rows — no service has written one.
--
-- Rollback: drop `network.config.grantId` and its trigger, then
-- `DROP SCHEMA entitlement CASCADE`.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM network.config) THEN
    RAISE EXCEPTION 'network.config has rows; F-026-b gives every config a Grant and cannot guess which';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- The schema and its grants
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS "entitlement";
GRANT USAGE ON SCHEMA entitlement TO txnet_app, txnet_cross_tenant;
ALTER DEFAULT PRIVILEGES IN SCHEMA entitlement GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO txnet_app, txnet_cross_tenant;
ALTER DEFAULT PRIVILEGES IN SCHEMA entitlement GRANT USAGE, SELECT ON SEQUENCES TO txnet_app, txnet_cross_tenant;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
CREATE TYPE "entitlement"."GrantSource" AS ENUM ('purchase', 'admin_grant', 'coupon', 'affiliate_reward', 'migration', 'trial', 'rollover');
CREATE TYPE "entitlement"."GrantStatus" AS ENUM ('pending', 'active', 'suspended', 'exhausted', 'expired', 'cancelled');
CREATE TYPE "entitlement"."SharingPolicy" AS ENUM ('exclusive', 'shared_pool');
CREATE TYPE "entitlement"."QuotaMetric" AS ENUM ('traffic_bytes', 'concurrent_devices', 'order_units', 'feature_items', 'api_calls');

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
CREATE TABLE "entitlement"."grant" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "variantId" UUID,
    "source" "entitlement"."GrantSource" NOT NULL,
    "sourceReferenceId" UUID,
    "status" "entitlement"."GrantStatus" NOT NULL DEFAULT 'pending',
    "statusReason" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "billingMode" "catalog"."VariantBillingMode" NOT NULL,
    "featureKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "quotas" JSONB NOT NULL DEFAULT '{}',
    "sharingPolicy" "entitlement"."SharingPolicy" NOT NULL DEFAULT 'exclusive',
    "subscriptionTokenHash" TEXT NOT NULL,
    "tokenRotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "billedBytes" BIGINT NOT NULL DEFAULT 0,
    "resellerPath" TEXT,
    "issuedByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grant_token_hash_shape" CHECK ("subscriptionTokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "grant_ends_after_start" CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt"),
    CONSTRAINT "grant_billed_bytes_not_negative" CHECK ("billedBytes" >= 0)
);

CREATE TABLE "entitlement"."quota_adjustment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "metric" "entitlement"."QuotaMetric" NOT NULL,
    "delta" BIGINT NOT NULL,
    "source" "entitlement"."GrantSource" NOT NULL,
    "capPercent" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quota_adjustment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quota_adjustment_delta_not_zero" CHECK ("delta" <> 0),
    CONSTRAINT "quota_adjustment_cap_percent_range" CHECK ("capPercent" IS NULL OR "capPercent" BETWEEN 1 AND 100)
);

CREATE UNIQUE INDEX "grant_subscriptionTokenHash_key" ON "entitlement"."grant"("subscriptionTokenHash");
CREATE INDEX "grant_tenantId_userId_idx" ON "entitlement"."grant"("tenantId", "userId");
CREATE INDEX "grant_userId_status_idx" ON "entitlement"."grant"("userId", "status");
CREATE UNIQUE INDEX "grant_source_reference" ON "entitlement"."grant"("source", "sourceReferenceId") WHERE "sourceReferenceId" IS NOT NULL;
CREATE INDEX "quota_adjustment_grantId_idx" ON "entitlement"."quota_adjustment"("grantId");
CREATE INDEX "quota_adjustment_tenantId_idx" ON "entitlement"."quota_adjustment"("tenantId");

ALTER TABLE "entitlement"."grant" ADD CONSTRAINT "grant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "identity"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "entitlement"."grant" ADD CONSTRAINT "grant_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "catalog"."product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "entitlement"."quota_adjustment" ADD CONSTRAINT "quota_adjustment_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "entitlement"."grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "network"."config" ADD COLUMN "grantId" UUID NOT NULL;
ALTER TABLE "network"."config" ADD CONSTRAINT "config_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "entitlement"."grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Whose a row is
-- -----------------------------------------------------------------------------
CREATE FUNCTION entitlement.same_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_tenant uuid;
BEGIN
  IF TG_TABLE_NAME = 'grant' THEN
    SELECT "tenantId" INTO owner_tenant FROM identity."user" WHERE id = NEW."userId";
    IF FOUND AND owner_tenant = NEW."tenantId" THEN
      IF NEW."variantId" IS NULL THEN
        RETURN NEW;
      END IF;
      -- The platform's variant is sold by every tenant; a tenant's only by that tenant.
      SELECT "tenantId" INTO owner_tenant FROM catalog.product_variant WHERE id = NEW."variantId";
      IF FOUND AND (owner_tenant IS NULL OR owner_tenant = NEW."tenantId") THEN
        RETURN NEW;
      END IF;
    END IF;
  ELSE
    -- quota_adjustment, network.config: their Grant's tenant.
    SELECT "tenantId" INTO owner_tenant FROM entitlement."grant" WHERE id = NEW."grantId";
    IF FOUND AND owner_tenant = NEW."tenantId" THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'entitlement_tenant_mismatch: % % must be its tenant''s', TG_TABLE_NAME, NEW.id
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER grant_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "userId", "variantId" ON "entitlement"."grant"
  FOR EACH ROW EXECUTE FUNCTION entitlement.same_tenant();
CREATE TRIGGER quota_adjustment_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "grantId" ON "entitlement"."quota_adjustment"
  FOR EACH ROW EXECUTE FUNCTION entitlement.same_tenant();
CREATE TRIGGER config_same_tenant_as_grant BEFORE INSERT OR UPDATE OF "tenantId", "grantId" ON "network"."config"
  FOR EACH ROW EXECUTE FUNCTION entitlement.same_tenant();

-- -----------------------------------------------------------------------------
-- A Grant's status moves one way (§4.4)
-- -----------------------------------------------------------------------------
CREATE FUNCTION entitlement.grant_status_one_way() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = OLD."status"
     OR (OLD."status" = 'pending'   AND NEW."status" IN ('active', 'cancelled'))
     OR (OLD."status" = 'active'    AND NEW."status" IN ('suspended', 'exhausted', 'expired', 'cancelled'))
     OR (OLD."status" = 'suspended' AND NEW."status" IN ('active', 'exhausted', 'expired', 'cancelled')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'grant_status_one_way: % -> % is not a move a Grant makes', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER grant_status_one_way BEFORE UPDATE OF "status" ON "entitlement"."grant"
  FOR EACH ROW EXECUTE FUNCTION entitlement.grant_status_one_way();

-- -----------------------------------------------------------------------------
-- A quota adjustment is history
-- -----------------------------------------------------------------------------
CREATE FUNCTION entitlement.quota_adjustment_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'quota_adjustment_is_history: an adjustment is never changed or deleted; write another'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER quota_adjustment_is_history BEFORE UPDATE OR DELETE ON "entitlement"."quota_adjustment"
  FOR EACH ROW EXECUTE FUNCTION entitlement.quota_adjustment_is_history();

-- -----------------------------------------------------------------------------
-- Row-Level Security: strictly tenant-scoped
-- (20260909001500_row_level_security_all_tables, list A)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'entitlement."grant"',
    'entitlement.quota_adjustment'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);

    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);

    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END
$$;
