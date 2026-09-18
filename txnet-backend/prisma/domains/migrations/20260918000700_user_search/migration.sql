-- F-018-ad — the platform owner finds a user (`GET /api/auth/users?q=`).
--
-- The `user.search` permission. `SuperAdmin` holds it through `*`; it is
-- granted to no other role, and the service admits only a caller whose tenant
-- is the `platform_owner` — a reseller that grants itself the key is refused.
--
-- Rollback: delete the permission.

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'user.search')
ON CONFLICT (key) DO NOTHING;
