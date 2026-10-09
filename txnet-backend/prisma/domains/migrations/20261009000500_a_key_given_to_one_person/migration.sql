-- AC-1-l (ADR-0138): a key given to or taken from one person, on top of their
-- role. One row per person and key; `take` wins over every source of the key.
--
-- Strict RLS on the person's tenant (shape A), as `governance.user_group`:
-- the writer runs in the tenant's `tenantTransaction`, and `AccessReader` reads
-- every person's rows on the cross-tenant pool by id.
--
-- A trigger notifies `identity_permissions_changed` with `{kind:"person"}`, so
-- the listener rewrites that person's `user:<id>:permissions` after commit —
-- the same path a role edit takes (ADR-0043 §4), whether the row was written
-- by the service or by SQL.
--
-- Rollback: drop the trigger, the function, the table and the enum. The two
-- audit enum values stay (an enum value cannot be dropped; nothing writes them
-- once the route is gone).

-- AlterEnum
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'user_permission_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'user_permission_lift';

-- CreateEnum
CREATE TYPE "identity"."UserPermissionEffect" AS ENUM ('give', 'take');

-- CreateTable
CREATE TABLE "identity"."user_permission" (
    "userId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "effect" "identity"."UserPermissionEffect" NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "grantedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_permission_pkey" PRIMARY KEY ("userId","permissionId")
);

-- CreateIndex
CREATE INDEX "user_permission_tenantId_idx" ON "identity"."user_permission"("tenantId");

-- CreateIndex
CREATE INDEX "user_permission_permissionId_idx" ON "identity"."user_permission"("permissionId");

-- AddForeignKey
ALTER TABLE "identity"."user_permission" ADD CONSTRAINT "user_permission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "identity"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."user_permission" ADD CONSTRAINT "user_permission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "identity"."permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "identity"."user_permission" ADD CONSTRAINT "user_permission_reason_ok" CHECK (length(btrim("reason")) > 0);

-- -----------------------------------------------------------------------------
-- The person's answer moved: their fingerprint is recomputed after commit.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION identity.notify_person_permissions_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM pg_notify(
      'identity_permissions_changed',
      json_build_object('kind', 'person', 'userId', NEW."userId")::text
    );
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM pg_notify(
      'identity_permissions_changed',
      json_build_object('kind', 'person', 'userId', OLD."userId")::text
    );
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER user_permission_changed
  AFTER INSERT OR UPDATE OR DELETE ON identity.user_permission
  FOR EACH ROW EXECUTE FUNCTION identity.notify_person_permissions_changed();

-- Strict shape (`20260909001500_row_level_security_all_tables`, shape A).
ALTER TABLE identity.user_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.user_permission FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON identity.user_permission;
CREATE POLICY tenant_isolation ON identity.user_permission
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

DROP POLICY IF EXISTS cross_tenant ON identity.user_permission;
CREATE POLICY cross_tenant ON identity.user_permission
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.user_permission TO txnet_app, txnet_cross_tenant;
