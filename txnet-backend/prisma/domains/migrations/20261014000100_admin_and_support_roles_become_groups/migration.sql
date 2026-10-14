-- The `Admin` and `Support` system templates retire into groups (GR-1-v,
-- ADR-0144). Staff access is a group's; the system roles left are `user` (the
-- base) and `SuperAdmin` (the owner's `*`). Nobody gains or loses a key:
--
--   * whoever still holds either template (GR-1-g moved only seated reseller
--     staff and the platform's users) becomes a member, with no end, of a group
--     of their own tenant named after the role, holding the role's keys — a
--     `platform.` key only on the platform's own tenant (GR-1-e) — and goes
--     back to `user`;
--   * a group whose `roleId` names either template takes the role's keys as
--     its own and drops the link;
--   * then the two roles and their key rows are deleted.
--
-- A tenant-made role named `Admin` or `Support` (`tenantId` set) is not a
-- template and is left alone. Group names a tenant already uses get " (2)",
-- " (3)", ...; the tenant's owner is the creator and adder (GR-1-g's way).
-- On a database without the templates it does nothing.

DO $$
DECLARE
  base_role uuid;
  pair record;
  gid uuid;
  gname text;
  n int;
BEGIN
  SELECT id INTO base_role FROM identity.role WHERE name = 'user' AND "tenantId" IS NULL;
  IF base_role IS NULL THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE gr1v_retired ON COMMIT DROP AS
    SELECT id, name FROM identity.role WHERE "tenantId" IS NULL AND name IN ('Admin', 'Support');

  FOR pair IN
    SELECT DISTINCT u."tenantId" AS tenant_id, r.id AS role_id, r.name,
           t."ownerUserId" AS owner, t."tenantType" = 'platform_owner' AS platform
      FROM identity."user" u
      JOIN gr1v_retired r ON r.id = u."roleId"
      JOIN tenant.tenant t ON t.id = u."tenantId"
     WHERE u."deletedAt" IS NULL
     ORDER BY u."tenantId", r.name
  LOOP
    gname := left(pair.name, 80);
    n := 1;
    WHILE EXISTS (SELECT 1 FROM governance.user_group WHERE "tenantId" = pair.tenant_id AND name = gname) LOOP
      n := n + 1;
      gname := left(pair.name, 72) || ' (' || n || ')';
    END LOOP;

    gid := gen_random_uuid();
    INSERT INTO governance.user_group (id, "tenantId", name, "createdByAdminId")
    VALUES (gid, pair.tenant_id, gname, pair.owner);

    INSERT INTO governance.user_group_permission ("groupId", "tenantId", "permissionId")
    SELECT gid, pair.tenant_id, rp."permissionId"
      FROM identity.role_permission rp
      JOIN identity.permission p ON p.id = rp."permissionId"
     WHERE rp."roleId" = pair.role_id
       AND p.key <> '*'
       AND (pair.platform OR p.key NOT LIKE 'platform.%');

    INSERT INTO governance.user_group_member (id, "groupId", "tenantId", "memberType", "userId", "addedByAdminId")
    SELECT gen_random_uuid(), gid, pair.tenant_id, 'user', u.id, pair.owner
      FROM identity."user" u
     WHERE u."tenantId" = pair.tenant_id AND u."roleId" = pair.role_id AND u."deletedAt" IS NULL;
  END LOOP;

  -- Deleted accounts too: the FK must let the role go.
  UPDATE identity."user" SET "roleId" = base_role
   WHERE "roleId" IN (SELECT id FROM gr1v_retired);

  INSERT INTO governance.user_group_permission ("groupId", "tenantId", "permissionId")
  SELECT g.id, g."tenantId", rp."permissionId"
    FROM governance.user_group g
    JOIN tenant.tenant t ON t.id = g."tenantId"
    JOIN identity.role_permission rp ON rp."roleId" = g."roleId"
    JOIN identity.permission p ON p.id = rp."permissionId"
   WHERE g."roleId" IN (SELECT id FROM gr1v_retired)
     AND p.key <> '*'
     AND (t."tenantType" = 'platform_owner' OR p.key NOT LIKE 'platform.%')
  ON CONFLICT ("groupId", "permissionId") DO NOTHING;

  UPDATE governance.user_group SET "roleId" = NULL
   WHERE "roleId" IN (SELECT id FROM gr1v_retired);

  DELETE FROM identity.role_permission WHERE "roleId" IN (SELECT id FROM gr1v_retired);
  DELETE FROM identity.role WHERE id IN (SELECT id FROM gr1v_retired);

END $$;
