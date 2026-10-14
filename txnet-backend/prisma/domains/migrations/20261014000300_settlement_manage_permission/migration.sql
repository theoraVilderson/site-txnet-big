-- `settlement.manage` is in the policy file (auth-handler/configs/permissions.yaml)
-- and so in the registry the group editor offers — the Finance preset ticks it —
-- but no migration ever inserted it, so a group given it was refused
-- `key_unknown` (user, 2026-10-14). No role grant: access is given by groups
-- now (GR-1-v), and the group editor is how it is handed out.
--
-- Rollback: delete the permission (cascades to the group and user rows).

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'settlement.manage')
ON CONFLICT (key) DO NOTHING;
