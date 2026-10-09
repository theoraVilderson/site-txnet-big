-- AC-1-e (catalog §3.2) — a reseller route is opened by its own key, not by
-- `tenant.manage`. The keys a reseller's own staff are given, as vocabulary
-- only: a key with no `permission` row is refused by the role editor, so a
-- reseller could not grant one. **No role is granted any of them** — the
-- templates keep what they held; `auth-handler/configs/permissions.yaml` lists
-- them under `Admin`, which is what puts them inside the tenant ceiling.
-- `role.manage` already exists (F-018-n).
--
-- Additive. Rollback: delete these permission rows (no role_permission row
-- names them unless a tenant granted one since).

INSERT INTO identity.permission (id, key)
VALUES
  (gen_random_uuid(), 'domain.manage'),
  (gen_random_uuid(), 'theme.manage'),
  (gen_random_uuid(), 'bot.manage'),
  (gen_random_uuid(), 'grant.assign'),
  (gen_random_uuid(), 'staff.manage'),
  (gen_random_uuid(), 'settings.manage'),
  (gen_random_uuid(), 'report.read'),
  (gen_random_uuid(), 'wallet.manual_adjust'),
  (gen_random_uuid(), 'credential.manage'),
  (gen_random_uuid(), 'audit.read'),
  (gen_random_uuid(), 'export.request'),
  (gen_random_uuid(), 'role.manage')
ON CONFLICT (key) DO NOTHING;
