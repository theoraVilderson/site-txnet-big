-- OPS-1-ag (ADR-0164 point 4, user 2026-10-24): a risky feature ships off and
-- is switched per tenant — on for the platform's own tenant, then for
-- resellers, and off again — without a deploy.
--
--   release_flag           — a flag's stage (off / platform / everyone), one
--                            row per key; no tenant, no RLS (as
--                            reseller_limit_setting). No row is `off`.
--   release_flag_exception — one reseller's own on or off over the stage;
--                            strict tenant RLS, as reseller_limit.
--
-- Keys are checked in code (`RELEASE_FLAGS`); here only their shape.
--
-- `platform.release.manage` switches them. Vocabulary only, as
-- `platform.support`: no role or group is given it here; SuperAdmin holds it
-- as `*`, and a platform group gives it by hand.
--
-- Additive; the rollback removes the two tables, then the type. The three
-- AdminAction values stay (Postgres cannot remove an enum value).

ALTER TYPE "audit"."AdminAction" ADD VALUE 'release_flag_stage_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'release_flag_exception_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'release_flag_exception_clear';

CREATE TYPE "tenant"."ReleaseFlagStage" AS ENUM ('off', 'platform', 'everyone');

CREATE TABLE "tenant"."release_flag" (
    "key" TEXT NOT NULL,
    "stage" "tenant"."ReleaseFlagStage" NOT NULL DEFAULT 'off',
    "updatedByUserId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "release_flag_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "release_flag_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,63}$')
);

CREATE TABLE "tenant"."release_flag_exception" (
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "isOn" BOOLEAN NOT NULL,
    "setByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "release_flag_exception_pkey" PRIMARY KEY ("tenantId", "key"),
    CONSTRAINT "release_flag_exception_key_shape" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,63}$')
);

CREATE INDEX "release_flag_exception_key_idx" ON "tenant"."release_flag_exception"("key");

ALTER TABLE "tenant"."release_flag_exception" ADD CONSTRAINT "release_flag_exception_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE tenant.release_flag_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant.release_flag_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.release_flag_exception
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON tenant.release_flag_exception
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'platform.release.manage')
ON CONFLICT (key) DO NOTHING;
