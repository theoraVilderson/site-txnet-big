-- BYO-1-a (ADR-0166) — `node.manage` opens a reseller's own panels: register,
-- logins, inbounds and groups, on its own tenant only. Vocabulary only: a key
-- with no `permission` row is refused by the role editor, so a reseller could
-- not grant it. **No role is granted it**; the reseller's owner passes the door
-- as its owner, and `auth-handler/configs/permissions.yaml` lists it under
-- `grantable:`, which puts it inside the tenant ceiling.
--
-- Additive. Rollback: delete this permission row (no role_permission row names
-- it unless a tenant granted it since).

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'node.manage')
ON CONFLICT (key) DO NOTHING;
