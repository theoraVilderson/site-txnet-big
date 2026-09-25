-- F-114-j: user groups — a named set of one tenant's users, the one target
-- discount rules (F-114-h), campaigns and restrictions share. Owned by
-- `governance`, served by auth-service (`governance/user-groups/`).
--
-- Every group is exactly one tenant's (strict RLS, shape A). The platform
-- owner's groups are simply the platform owner's tenant's, and they alone may
-- reach past it: a reseller as a member, another tenant's user, or every
-- reseller at once (`allTenants`). The trigger below refuses those anywhere
-- else, so the rule does not rest on the service alone.
--
-- Membership is `manual` (`kind`); a computed kind is a new enum value later.
-- A discount rule may now serve one group (`discount_rule.groupId`), through
-- the same (id, tenantId) key members use, so neither can name another
-- tenant's group; a group a rule names is not deleted (RESTRICT).
--
-- `user_group.manage`, granted to `Admin` as `campaign.manage` is.
--
-- Rollback: drop both tables, the column, the trigger function, the two enums
-- and the permission's rows.

-- CreateEnum
CREATE TYPE "governance"."UserGroupMemberType" AS ENUM ('user', 'tenant');

-- CreateEnum
CREATE TYPE "governance"."UserGroupKind" AS ENUM ('manual');

-- AlterEnum


ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'user_group_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'user_group_update';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'user_group_delete';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'user_group_member_add';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'user_group_member_remove';

-- AlterEnum
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'user_group';

-- AlterTable
ALTER TABLE "billing"."discount_rule" ADD COLUMN     "groupId" UUID;

-- CreateTable
CREATE TABLE "governance"."user_group" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "kind" "governance"."UserGroupKind" NOT NULL DEFAULT 'manual',
    "allTenants" BOOLEAN NOT NULL DEFAULT false,
    "createdByAdminId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance"."user_group_member" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "memberType" "governance"."UserGroupMemberType" NOT NULL,
    "userId" UUID,
    "memberTenantId" UUID,
    "addedByAdminId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_group_member_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_group_tenantId_name_key" ON "governance"."user_group"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "user_group_id_tenantId_key" ON "governance"."user_group"("id", "tenantId");

-- CreateIndex
CREATE INDEX "user_group_member_userId_idx" ON "governance"."user_group_member"("userId");

-- CreateIndex
CREATE INDEX "user_group_member_memberTenantId_idx" ON "governance"."user_group_member"("memberTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "user_group_member_groupId_userId_key" ON "governance"."user_group_member"("groupId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_group_member_groupId_memberTenantId_key" ON "governance"."user_group_member"("groupId", "memberTenantId");

-- AddForeignKey
ALTER TABLE "billing"."discount_rule" ADD CONSTRAINT "discount_rule_groupId_tenantId_fkey" FOREIGN KEY ("groupId", "tenantId") REFERENCES "governance"."user_group"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "governance"."user_group_member" ADD CONSTRAINT "user_group_member_groupId_tenantId_fkey" FOREIGN KEY ("groupId", "tenantId") REFERENCES "governance"."user_group"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "governance"."user_group" ADD CONSTRAINT "user_group_name_ok" CHECK (length(btrim("name")) > 0);

ALTER TABLE "governance"."user_group_member" ADD CONSTRAINT "user_group_member_one_subject" CHECK (
    ("memberType" = 'user' AND "userId" IS NOT NULL AND "memberTenantId" IS NULL)
    OR ("memberType" = 'tenant' AND "memberTenantId" IS NOT NULL AND "userId" IS NULL)
);

-- A rule serves everyone, its named users, or one group — never two of them.
ALTER TABLE "billing"."discount_rule" ADD CONSTRAINT "discount_rule_one_audience"
    CHECK (NOT ("forNamedUsers" AND "groupId" IS NOT NULL));

-- -----------------------------------------------------------------------------
-- Only the platform owner's groups reach past their own tenant
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER for the coupon policy's reason (20260914000900): under the
-- caller's RLS a reseller's connection cannot see another tenant's user, so
-- "is this user mine" would read as "no such user" rather than "not yours".
CREATE FUNCTION governance.user_group_scope_ok() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  is_platform boolean;
  user_tenant uuid;
BEGIN
  SELECT t."tenantType" = 'platform_owner' INTO is_platform
    FROM tenant.tenant t WHERE t.id = NEW."tenantId";
  IF coalesce(is_platform, false) THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'user_group' THEN
    IF NEW."allTenants" THEN
      RAISE EXCEPTION 'user_group_platform_only: only the platform owner''s group holds every reseller'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."memberType" = 'tenant' THEN
    RAISE EXCEPTION 'user_group_platform_only: only the platform owner''s group holds a reseller'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT u."tenantId" INTO user_tenant FROM identity."user" u WHERE u.id = NEW."userId";
  IF user_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'user_group_platform_only: a group holds its own tenant''s users'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER user_group_scope_ok BEFORE INSERT OR UPDATE OF "tenantId", "allTenants" ON "governance"."user_group"
  FOR EACH ROW EXECUTE FUNCTION governance.user_group_scope_ok();
CREATE TRIGGER user_group_member_scope_ok BEFORE INSERT OR UPDATE ON "governance"."user_group_member"
  FOR EACH ROW EXECUTE FUNCTION governance.user_group_scope_ok();

-- Strict shape (`20260909001500_row_level_security_all_tables`, shape A).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'governance.user_group',
    'governance.user_group_member'
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

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'user_group.manage')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.role_permission ("roleId", "permissionId")
SELECT r.id, p.id
FROM identity.role r
JOIN identity.permission p ON p.key = 'user_group.manage'
WHERE r.name = 'Admin'
ON CONFLICT DO NOTHING;
