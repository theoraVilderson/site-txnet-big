-- AC-1-m (ADR-0138): a user group holds access — a role of its tenant and/or
-- extra keys — and its user members of the group's own tenant hold them while
-- they are members.
--
-- `user_group.roleId` names the role (RESTRICT: a role a group gives is
-- `role.inUse`, as one a person holds). `user_group_permission` holds the extra
-- keys, under the group's (id, tenantId) key with strict RLS, as members are.
--
-- Triggers notify `identity_permissions_changed`, so the listener moves the
-- tokens after commit whoever wrote the row:
--   * the group's role or keys changed -> `{kind:"group", groupId}` (every member);
--   * a user member added or removed   -> `{kind:"person", userId}`.
--
-- Rollback: drop the triggers, the two functions, the table and the column.
-- The audit enum value stays.

-- AlterEnum
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'user_group_access_set';

-- AlterTable
ALTER TABLE "governance"."user_group" ADD COLUMN "roleId" UUID;

-- CreateTable
CREATE TABLE "governance"."user_group_permission" (
    "groupId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,

    CONSTRAINT "user_group_permission_pkey" PRIMARY KEY ("groupId","permissionId")
);

-- CreateIndex
CREATE INDEX "user_group_permission_tenantId_idx" ON "governance"."user_group_permission"("tenantId");

-- AddForeignKey
ALTER TABLE "governance"."user_group" ADD CONSTRAINT "user_group_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "identity"."role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "governance"."user_group_permission" ADD CONSTRAINT "user_group_permission_groupId_tenantId_fkey" FOREIGN KEY ("groupId", "tenantId") REFERENCES "governance"."user_group"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "governance"."user_group_permission" ADD CONSTRAINT "user_group_permission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "identity"."permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- What a group gives moved: every member's fingerprint is recomputed.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION governance.notify_group_access_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  gid uuid;
BEGIN
  IF TG_TABLE_NAME = 'user_group' THEN
    gid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    gid := OLD."groupId";
  ELSE
    gid := NEW."groupId";
  END IF;
  PERFORM pg_notify(
    'identity_permissions_changed',
    json_build_object('kind', 'group', 'groupId', gid)::text
  );
  RETURN NULL;
END
$$;

CREATE TRIGGER user_group_role_changed
  AFTER UPDATE OF "roleId" ON governance.user_group
  FOR EACH ROW WHEN (OLD."roleId" IS DISTINCT FROM NEW."roleId")
  EXECUTE FUNCTION governance.notify_group_access_changed();

CREATE TRIGGER user_group_permission_changed
  AFTER INSERT OR DELETE ON governance.user_group_permission
  FOR EACH ROW EXECUTE FUNCTION governance.notify_group_access_changed();

-- A person joined or left a group: theirs alone. Every user membership, not
-- only one of a group with access — a recompute of someone nothing applies to
-- is one `DEL`, and the trigger stays free of a read of the group.
CREATE OR REPLACE FUNCTION governance.notify_group_member_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  uid uuid;
BEGIN
  uid := CASE WHEN TG_OP = 'DELETE' THEN OLD."userId" ELSE NEW."userId" END;
  IF uid IS NOT NULL THEN
    PERFORM pg_notify(
      'identity_permissions_changed',
      json_build_object('kind', 'person', 'userId', uid)::text
    );
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER user_group_member_changed
  AFTER INSERT OR DELETE ON governance.user_group_member
  FOR EACH ROW EXECUTE FUNCTION governance.notify_group_member_changed();

-- Strict shape (`20260909001500_row_level_security_all_tables`, shape A).
ALTER TABLE governance.user_group_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance.user_group_permission FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON governance.user_group_permission;
CREATE POLICY tenant_isolation ON governance.user_group_permission
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

DROP POLICY IF EXISTS cross_tenant ON governance.user_group_permission;
CREATE POLICY cross_tenant ON governance.user_group_permission
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON governance.user_group_permission TO txnet_app, txnet_cross_tenant;
