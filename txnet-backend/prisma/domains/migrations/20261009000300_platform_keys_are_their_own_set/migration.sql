-- AC-1-c (catalog §3.3, ADR-0135) — the platform's staff permissions are a
-- set of their own, under `platform.`. Vocabulary only: **no role is granted
-- any** — SuperAdmin holds them as `*`, and the role editor refuses them on
-- every tenant-made role. AC-1-d moves the platform's routes onto them.
--
-- Additive. Rollback: delete these permission rows.

INSERT INTO identity.permission (id, key)
VALUES
  (gen_random_uuid(), 'platform.tenant.create'),
  (gen_random_uuid(), 'platform.tenant.manage'),
  (gen_random_uuid(), 'platform.plan.assign'),
  (gen_random_uuid(), 'platform.node.manage'),
  (gen_random_uuid(), 'platform.report.read'),
  (gen_random_uuid(), 'platform.impersonate')
ON CONFLICT (key) DO NOTHING;
