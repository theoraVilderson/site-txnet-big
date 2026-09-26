-- F-027-cp — a re-split wakes its panel: `allocatedCeilingBytes` joins the
-- columns that notify `network_converge` (F-111-j), so a new share reaches
-- the panel in seconds instead of at the next bulk pass, up to 60s later. A
-- user running fast past their old share is cut mid-download in that gap
-- while the block that covers it is already bought.
--
-- Still only columns no process in network-service writes: the allocator in
-- billing-service is the one writer (`contract.ceiling.md`), so a turn never
-- wakes the next. A hot config re-split on every block is bounded by the
-- per-panel debounce and the 10s floor between woken turns (F-111-o).
--
-- Rollback: re-run the function and trigger of
-- `20260926000200_a_new_config_wakes_its_panel`. A share then reaches its
-- panel on the next bulk pass, as before.

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
     OLD."allocatedCeilingBytes" IS NOT DISTINCT FROM NEW."allocatedCeilingBytes" AND
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

DROP TRIGGER converge_config_changed ON network.config;

CREATE TRIGGER converge_config_changed
  AFTER INSERT OR UPDATE OF "desiredEnabled", "desiredRemote", uuid, "inboundRemoteId", "allocatedCeilingBytes", "panelId"
  ON network.config
  FOR EACH ROW EXECUTE FUNCTION network.notify_converge_config_changed();
