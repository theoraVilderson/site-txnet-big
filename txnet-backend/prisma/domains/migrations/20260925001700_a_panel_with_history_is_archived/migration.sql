-- F-027-bz: deleting a panel. One with no history is deleted; one with
-- history — configs, usage, holds, drift — is archived instead: `retiredAt`
-- set, every loop skips it, and its rows stay for the record (user,
-- 2026-09-25, the catalog's rule for products, F-026-i).
--
-- The service refuses archiving while a group holds the panel or a config on
-- it is live. The two triggers below hold the other direction, so the rule
-- does not rest on the service alone: nothing places a config on, or adds to a
-- group, a panel that is archived. `network-service`'s reads skip it in their
-- own `WHERE`; the watchdog below stops expecting it to be collected.
--
-- Additive. Rollback: drop both triggers and their functions, restore the
-- previous `collection_watchdog()` body, drop the column.

ALTER TABLE "network"."panel" ADD COLUMN "retiredAt" TIMESTAMP(3);

-- SECURITY DEFINER: under the caller's RLS an unseen panel would read as
-- "not archived", and a trigger must not pass what it cannot see.
CREATE FUNCTION network.panel_not_retired()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM network.panel p WHERE p.id = NEW."panelId" AND p."retiredAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'panel % is archived', NEW."panelId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER config_panel_not_retired
  BEFORE INSERT OR UPDATE OF "panelId" ON network.config
  FOR EACH ROW EXECUTE FUNCTION network.panel_not_retired();

CREATE TRIGGER panel_group_member_panel_not_retired
  BEFORE INSERT OR UPDATE OF "panelId" ON network.panel_group_member
  FOR EACH ROW EXECUTE FUNCTION network.panel_not_retired();

CREATE OR REPLACE FUNCTION network.collection_watchdog()
  RETURNS TABLE (stalest_panel_seconds float8, panels_expected bigint, panels_never_collected bigint)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    COALESCE(MAX(EXTRACT(EPOCH FROM (now() - p."lastSuccessfulCollectionAt"))), -1)::float8,
    COUNT(*)::bigint,
    COUNT(*) FILTER (WHERE p."lastSuccessfulCollectionAt" IS NULL)::bigint
  FROM network.panel p
  WHERE p."reviewState" IN ('accepted', 'accepted_low_trust')
    AND p."panelState" <> 'maintenance'
    AND p."retiredAt" IS NULL
$$;
