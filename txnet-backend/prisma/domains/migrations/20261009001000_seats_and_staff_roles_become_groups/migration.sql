-- Seats and staff roles become groups, once (GR-1-g, ADR-0139 (6)).
--
-- A group is now the only way the panel gives access (ADR-0139 (1)), and
-- membership is admission (GR-1-a). The access people already hold moves
-- onto groups, so nobody gains or loses a key:
--
--   * a reseller: each role held by its **seated** people — joined, not
--     revoked, not past the seat's end — becomes a group of that tenant with
--     the role's keys; its members are those people, each with their seat's
--     end;
--   * the platform's own tenant (no seats): each role its users hold becomes
--     a platform group the same way, with no end. A `platform.` key goes
--     with it (GR-1-e); on a reseller's group it never does;
--   * those people go back to the `user` template.
--
-- Left as they are: a role holding `*` (the owner's — no group may give `*`,
-- ADR-0138 (7)), the `user` template itself, invited seats nobody accepted,
-- ended or revoked seats, and anyone holding a staff role **without** a seat
-- on a reseller. The seat rows stay, for history (ADR-0139 (6)).
--
-- Group names are the role's; a name the tenant already uses gets " (2)",
-- " (3)", ... Whoever owns the tenant is recorded as the creator and adder.
-- Each person's keys are the same before and after, so the triggers' token
-- move is a refresh, never a change in what they may do.
--
-- One DO block on purpose: `auth-service/.../roles-become-groups.int.spec.ts`
-- seeds people and runs this same text again. On an empty database (no `user`
-- template yet, as the harness starts) it does nothing.

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

  CREATE TEMP TABLE gr1g_holder (user_id uuid, tenant_id uuid, role_id uuid, expires_at timestamp(3), platform boolean);

  INSERT INTO gr1g_holder
  SELECT u.id, u."tenantId", u."roleId", s."accessExpiresAt", false
    FROM identity."user" u
    JOIN tenant.tenant t ON t.id = u."tenantId" AND t."tenantType" <> 'platform_owner'
    JOIN tenant.tenant_staff_member s ON s."tenantId" = u."tenantId" AND s."userId" = u.id
   WHERE u."deletedAt" IS NULL
     AND s."joinedAt" IS NOT NULL
     AND s."revokedAt" IS NULL
     AND (s."accessExpiresAt" IS NULL OR s."accessExpiresAt" > now());

  INSERT INTO gr1g_holder
  SELECT u.id, u."tenantId", u."roleId", NULL, true
    FROM identity."user" u
    JOIN tenant.tenant t ON t.id = u."tenantId" AND t."tenantType" = 'platform_owner'
   WHERE u."deletedAt" IS NULL;

  DELETE FROM gr1g_holder h
   WHERE h.role_id = base_role
      OR EXISTS (SELECT 1 FROM identity.role_permission rp
                   JOIN identity.permission p ON p.id = rp."permissionId"
                  WHERE rp."roleId" = h.role_id AND p.key = '*');

  FOR pair IN
    SELECT DISTINCT h.tenant_id, h.role_id, h.platform, r.name, t."ownerUserId" AS owner
      FROM gr1g_holder h
      JOIN identity.role r ON r.id = h.role_id
      JOIN tenant.tenant t ON t.id = h.tenant_id
     ORDER BY h.tenant_id, r.name
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

    INSERT INTO governance.user_group_member (id, "groupId", "tenantId", "memberType", "userId", "addedByAdminId", "expiresAt")
    SELECT gen_random_uuid(), gid, pair.tenant_id, 'user', h.user_id, pair.owner, h.expires_at
      FROM gr1g_holder h
     WHERE h.tenant_id = pair.tenant_id AND h.role_id = pair.role_id;
  END LOOP;

  UPDATE identity."user" u
     SET "roleId" = base_role
    FROM gr1g_holder h
   WHERE u.id = h.user_id;

  DROP TABLE gr1g_holder;
END $$;
