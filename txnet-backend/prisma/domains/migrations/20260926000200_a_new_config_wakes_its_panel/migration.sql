-- F-111-j — a config whose desired state changed wakes its panel's
-- convergence turn at once, instead of waiting up to a minute for the bulk
-- pass (diagnosed 2026-09-26: purchase to active took 3-4 minutes).
--
-- A trigger rather than application code, for ADR-0083's reason: the desired
-- state is written by billing (a purchase, an admin's suspend or delete, a
-- drain) and by hand, and a trigger is the one writer that hears all of them.
-- NOTIFY is delivered after the writing transaction commits, and identical
-- payloads in one transaction fold into one, so a purchase that places a
-- Grant on a whole mirror group wakes each member panel once.
--
-- One channel, `network_converge`; the payload is the panel id, nothing else.
-- network-service listens (`collect.WakeListener`) and debounces per panel.
--
-- Only the columns the convergence pass acts on and **no process in
-- network-service writes** fire: the pass records `remoteId`,
-- `enforcementState` and the captured lines on every turn, and a wake per
-- record would be a turn that wakes the next one for ever. A config moved to
-- another panel wakes both.
--
-- Rollback: drop the trigger and the function. Without them a new config is
-- placed on the next bulk pass, as before.

CREATE OR REPLACE FUNCTION network.notify_converge_config_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_notify('network_converge', NEW."panelId"::text);
    RETURN NULL;
  END IF;
  IF OLD."desiredEnabled" IS NOT DISTINCT FROM NEW."desiredEnabled" AND
     OLD."desiredRemote" IS NOT DISTINCT FROM NEW."desiredRemote" AND
     OLD.uuid IS NOT DISTINCT FROM NEW.uuid AND
     OLD."inboundRemoteId" IS NOT DISTINCT FROM NEW."inboundRemoteId" AND
     OLD."panelId" IS NOT DISTINCT FROM NEW."panelId" THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify('network_converge', NEW."panelId"::text);
  IF OLD."panelId" IS DISTINCT FROM NEW."panelId" THEN
    PERFORM pg_notify('network_converge', OLD."panelId"::text);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER converge_config_changed
  AFTER INSERT OR UPDATE OF "desiredEnabled", "desiredRemote", uuid, "inboundRemoteId", "panelId"
  ON network.config
  FOR EACH ROW EXECUTE FUNCTION network.notify_converge_config_changed();
