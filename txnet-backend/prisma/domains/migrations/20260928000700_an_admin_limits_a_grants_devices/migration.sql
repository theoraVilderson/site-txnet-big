-- F-311-q — an admin sets a Grant's device limit.
--
-- The limit is the Grant's own `quotas.concurrent_devices.limit`, the entry a
-- variant's sold limit is copied into: no new column and no second copy. The
-- convergence pass reads it beside the config and writes it as the client's
-- address limit (`limitIp`) on a panel whose capability document answers
-- `per_client_ip_limit` yes, and nowhere else.
--
-- This only wakes every panel the Grant has a config on when that entry
-- changes (F-111-j's channel, as `grant_rate_limit` does), so the limit
-- reaches the panel in seconds, not on the next bulk pass.
--
-- Additive: a function and a trigger, no data touched. Rollback: drop both;
-- a changed limit then reaches the panel on the next pass instead.

CREATE OR REPLACE FUNCTION network.notify_converge_grant_devices_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p UUID;
BEGIN
  FOR p IN SELECT DISTINCT c."panelId" FROM network.config c
            WHERE c."grantId" = NEW.id AND c."desiredRemote" = 'present' LOOP
    PERFORM pg_notify('network_converge', p::text);
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER converge_grant_devices_changed
  AFTER UPDATE OF quotas ON entitlement."grant"
  FOR EACH ROW
  WHEN (OLD.quotas -> 'concurrent_devices' IS DISTINCT FROM NEW.quotas -> 'concurrent_devices')
  EXECUTE FUNCTION network.notify_converge_grant_devices_changed();
