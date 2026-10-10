-- GR-1-q (ADR-0141) — `platform.support`: a reseller's people under its
-- consent, with the act's own key. Vocabulary only: no role or group is given
-- it here; SuperAdmin holds it as `*`, and a platform group gives it by hand.
--
-- Additive. Rollback: delete this permission row.

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'platform.support')
ON CONFLICT (key) DO NOTHING;
