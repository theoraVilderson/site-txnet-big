-- F-1601-d3 — User Manager logins and NASes are `router_login`.
--
-- An adopted User Manager login was recorded as `pppoe` (F-1601-b3), and a
-- NAS with no protocol. Both now read `router_login`, the one protocol the
-- driver creates there. A push panel's `pppoe` (a RADIUS NAS) is a real PPPoE
-- session and is left as it is. No row is deleted and none is rejected: one
-- enum value is rewritten to another on User Manager panels only; the
-- inventory pass would write the inbounds' on its next read anyway.

UPDATE "network"."config" c
   SET "protocol" = 'router_login'
  FROM "network"."panel" p
 WHERE p."id" = c."panelId"
   AND p."driverType" = 'mikrotik_user_manager'
   AND c."protocol" = 'pppoe';

UPDATE "network"."panel_inbound" i
   SET "protocol" = 'router_login'
  FROM "network"."panel" p
 WHERE p."id" = i."panelId"
   AND p."driverType" = 'mikrotik_user_manager'
   AND i."protocol" IS NULL;
