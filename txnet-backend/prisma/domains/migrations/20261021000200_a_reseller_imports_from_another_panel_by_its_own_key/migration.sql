-- F-201-d (D-63) — `migration.manage` opens a reseller's import: storing the
-- source panel's address and login for one run. Vocabulary only: a key with no
-- `permission` row is refused by the role editor, so a reseller could not grant
-- it. **No role is granted it**; `auth-handler/configs/permissions.yaml` lists it
-- under `grantable:`, which puts it inside the tenant ceiling.
--
-- Additive. Rollback: delete this permission row (no role_permission row names
-- it unless a tenant granted it since).

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'migration.manage')
ON CONFLICT (key) DO NOTHING;
