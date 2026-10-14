-- Seven keys the policy names whose `identity.permission` rows were made only
-- by the seed's old SuperAdmin key list, dropped when SuperAdmin moved to `*`
-- (9bfbd609). An existing database still has them; a fresh one did not, and a
-- group given one was refused `key_unknown`. `tools/contracts.py`
-- (check_permission_rows) now fails on any policy key no migration inserts.
-- No role grant: access is given by groups (GR-1-v).
--
-- Rollback: none needed; the rows are inert until a group or user holds them.

INSERT INTO identity.permission (id, key)
SELECT gen_random_uuid(), k
FROM unnest(ARRAY[
  'bot.webhook_rotate',
  'self.read',
  'self.write',
  'user.impersonate',
  'user.read',
  'user.write',
  'worker.manage'
]) AS k
ON CONFLICT (key) DO NOTHING;
