-- F-502-a (D-33, ADR-0048) — the storage coupon management needs.
-- Hand-written in part: Prisma cannot express a partial unique index, a
-- function or a policy.
--
-- 1. A code is unique inside a tenant, not platform-wide. Two resellers may
--    both sell `NOWRUZ`. Platform coupons (`tenantId` NULL) are unique among
--    themselves. A soft-deleted coupon frees its code.
-- 2. A platform coupon no longer serves every tenant's users. It serves the
--    tenants its `coupon_tenant` rows name, and with none the platform owner's
--    own users. The shared-read side of `billing.coupon`'s RLS policy changes
--    from `NULL OR mine` to `mine OR (NULL AND it serves me)`; `WITH CHECK`
--    stays strict. Existing platform coupons get no rows: from here they serve
--    the platform owner's users only (ADR-0048 decision 2).
-- 3. Soft delete, a label and a note, and a gift-code batch.
-- 4. The `coupon.manage` permission, granted to `Admin` as `gateway.manage` is.
--
-- Rollback: drop the two tables, the new columns, `coupon_tenant_code_live` /
-- `coupon_platform_code_live`, `billing.platform_coupon_serves`; restore
-- `coupon_code_key` and the `NULL OR mine` policy; delete the permission.

DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'platform_coupon_serves needs an owner that bypasses RLS; % does not', current_user;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Columns
-- -----------------------------------------------------------------------------
ALTER TABLE "billing"."coupon"
  ADD COLUMN "label" TEXT,
  ADD COLUMN "note" TEXT,
  ADD COLUMN "batchId" UUID,
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "deletedByAdminId" UUID,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- A deleted coupon records who deleted it; a live one names nobody.
ALTER TABLE "billing"."coupon" ADD CONSTRAINT "coupon_deleted_by_pair"
  CHECK (("deletedAt" IS NULL) = ("deletedByAdminId" IS NULL));

-- -----------------------------------------------------------------------------
-- A code is unique inside a tenant
-- -----------------------------------------------------------------------------
DROP INDEX "billing"."coupon_code_key";
CREATE UNIQUE INDEX "coupon_tenant_code_live" ON "billing"."coupon" ("tenantId", "code")
  WHERE "tenantId" IS NOT NULL AND "deletedAt" IS NULL;
CREATE UNIQUE INDEX "coupon_platform_code_live" ON "billing"."coupon" ("code")
  WHERE "tenantId" IS NULL AND "deletedAt" IS NULL;
-- Prisma's own `@@index([tenantId, code])`, so `migrate diff` stays quiet.
CREATE INDEX "coupon_tenantId_code_idx" ON "billing"."coupon" ("tenantId", "code");

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
CREATE TABLE "billing"."coupon_tenant" (
    "id" UUID NOT NULL,
    "couponId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,

    CONSTRAINT "coupon_tenant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "coupon_tenant_couponId_tenantId_key" ON "billing"."coupon_tenant" ("couponId", "tenantId");
CREATE INDEX "coupon_tenant_tenantId_idx" ON "billing"."coupon_tenant" ("tenantId");
ALTER TABLE "billing"."coupon_tenant" ADD CONSTRAINT "coupon_tenant_couponId_fkey"
  FOREIGN KEY ("couponId") REFERENCES "billing"."coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "billing"."coupon_batch" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "label" TEXT NOT NULL,
    "note" TEXT,
    "createdByAdminId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" TIMESTAMP(3),

    CONSTRAINT "coupon_batch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "coupon_batch_tenantId_createdAt_idx" ON "billing"."coupon_batch" ("tenantId", "createdAt");
CREATE INDEX "coupon_batchId_idx" ON "billing"."coupon" ("batchId");
ALTER TABLE "billing"."coupon" ADD CONSTRAINT "coupon_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "billing"."coupon_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Whom a platform coupon serves
-- -----------------------------------------------------------------------------
-- A SECURITY DEFINER function, not a subquery in the policy: the policy would
-- otherwise read `coupon_tenant` and `tenant.tenant` under the caller's own RLS,
-- which hides the platform owner's tenant row from a reseller's connection.
-- It answers one boolean and nothing else. `reserve_coupon` and
-- `redeem_gift_coupon` call it too (F-502-b).
CREATE FUNCTION billing.platform_coupon_serves(p_coupon_id uuid, p_tenant_id uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_tenant_id IS NULL THEN false
    WHEN EXISTS (SELECT 1 FROM billing.coupon_tenant WHERE "couponId" = p_coupon_id)
      THEN EXISTS (SELECT 1 FROM billing.coupon_tenant
                    WHERE "couponId" = p_coupon_id AND "tenantId" = p_tenant_id)
    ELSE EXISTS (SELECT 1 FROM tenant.tenant
                  WHERE id = p_tenant_id AND "tenantType" = 'platform_owner')
  END
$$;
REVOKE ALL ON FUNCTION billing.platform_coupon_serves(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.platform_coupon_serves(uuid, uuid) TO txnet_app, txnet_cross_tenant;

-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------
-- `billing.coupon`: only the read side changes. Writing stays `mine` only.
DROP POLICY IF EXISTS tenant_isolation ON billing.coupon;
CREATE POLICY tenant_isolation ON billing.coupon
  AS PERMISSIVE FOR ALL TO txnet_app
  USING (
    "tenantId" = public.current_tenant_id()
    OR ("tenantId" IS NULL AND billing.platform_coupon_serves(id, public.current_tenant_id()))
  )
  WITH CHECK ("tenantId" = public.current_tenant_id());

-- `coupon_tenant`: shape A (strict). A tenant reads the rows naming it; writing
-- them is the platform owner's, on the cross-tenant pool (F-502-c).
-- `coupon_batch`: a tenant reads and writes its own batches; a platform batch
-- (`tenantId` NULL) is reached on the cross-tenant pool only.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing.coupon_tenant',
    'billing.coupon_batch'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);

    EXECUTE format('DROP POLICY IF EXISTS cross_tenant ON %s', t);
    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- The permission
-- -----------------------------------------------------------------------------
-- As `gateway.manage` (20260913000300): every tenant's Admin manages its own
-- coupons; the service, not the permission, keeps platform coupons and other
-- tenants' for the platform owner (F-502-c). A no-op on a fresh database, where
-- `prisma/seed.js` makes the same grant.
INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'coupon.manage')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'coupon.manage'
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;
