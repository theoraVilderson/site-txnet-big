-- F-203-b (ADR-0083 rule 4): a `/sub` render now reads
-- `entitlement.legacy_sub_link`, so a change to it outdates the Grant's
-- cached renders, as a change to the Grant does. A rollback's close and a
-- link reset also change the Grant itself; this is the trigger that does not
-- depend on them, so a link removed by hand stops answering too.
--
-- Rollback: drop the trigger and the function.

CREATE OR REPLACE FUNCTION entitlement.notify_sub_legacy_link_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'grant', 'id', NEW."grantId")::text);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'grant', 'id', OLD."grantId")::text);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER sub_legacy_link_changed
  AFTER INSERT OR UPDATE OR DELETE ON entitlement.legacy_sub_link
  FOR EACH ROW EXECUTE FUNCTION entitlement.notify_sub_legacy_link_changed();
