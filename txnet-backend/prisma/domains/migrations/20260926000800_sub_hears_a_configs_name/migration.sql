-- F-307-h — `/sub` names each line (ADR-0089): the buyer's `userLabel`, else
-- the panel's `region`. Both now reach the render cache (sub-api contract.md,
-- the cache rule): the config trigger also fires on "userLabel", and the
-- panel trigger on region, so a renamed config or region is served by name on
-- the next request instead of after the cache TTL.
--
-- Rollback: restore both functions and triggers from 20260924000700.

CREATE OR REPLACE FUNCTION network.notify_sub_panel_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'panel', 'id', OLD.id)::text);
  ELSIF OLD."panelState" IS DISTINCT FROM NEW."panelState" OR
        OLD.region IS DISTINCT FROM NEW.region THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'panel', 'id', NEW.id)::text);
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER sub_panel_changed ON network.panel;
CREATE TRIGGER sub_panel_changed
  AFTER UPDATE OF "panelState", region OR DELETE ON network.panel
  FOR EACH ROW EXECUTE FUNCTION network.notify_sub_panel_changed();

CREATE OR REPLACE FUNCTION network.notify_sub_config_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
     OLD."grantId" IS NOT DISTINCT FROM NEW."grantId" AND
     OLD."panelId" IS NOT DISTINCT FROM NEW."panelId" AND
     OLD.status IS NOT DISTINCT FROM NEW.status AND
     OLD."desiredRemote" IS NOT DISTINCT FROM NEW."desiredRemote" AND
     OLD.uuid IS NOT DISTINCT FROM NEW.uuid AND
     OLD."linkLines" IS NOT DISTINCT FROM NEW."linkLines" AND
     OLD."linksUuid" IS NOT DISTINCT FROM NEW."linksUuid" AND
     OLD."userLabel" IS NOT DISTINCT FROM NEW."userLabel" THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'grant', 'id', NEW."grantId")::text);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'grant', 'id', OLD."grantId")::text);
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER sub_config_changed ON network.config;
CREATE TRIGGER sub_config_changed
  AFTER INSERT OR DELETE OR UPDATE OF "grantId", "panelId", status, "desiredRemote", uuid, "linkLines", "linksUuid", "userLabel"
  ON network.config
  FOR EACH ROW EXECUTE FUNCTION network.notify_sub_config_changed();
