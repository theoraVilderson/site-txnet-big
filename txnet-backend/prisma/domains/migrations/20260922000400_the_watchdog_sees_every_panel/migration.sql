-- F-027-w — the collector watchdog reads every panel, not only the platform's.
--
-- `postgres-exporter` connects as `txnet_app_user`, and `network.panel` is
-- shared-read under RLS (20260909001500, list B): with no `app.tenant_id`
-- bound, that role sees the platform's panels and **none** of a tenant's. A
-- watchdog asking the table directly would therefore report a dedicated panel
-- that has stopped being collected as nothing at all — the silent reading this
-- whole row exists to remove. Same argument, same answer, as
-- `billing.coupons_over_limit()` (20260914000600): a `SECURITY DEFINER`
-- function that answers three numbers and nothing else, so the exporter never
-- holds a view of which tenant owns which panel.
--
-- In scope: panels accepted by the questionnaire (ADR-0074) and not in
-- `maintenance`. `pending` and `refused` panels have never been asked, and a
-- panel somebody put into maintenance is not a stall. `down` and
-- `throttled_or_blocked` count: a panel refusing us for an hour is exactly a
-- thing a person has to act on.
--
-- `stalest_panel_seconds` is over panels that **have** been collected, and -1
-- where none has: zero seconds is the healthiest possible reading, so a
-- platform with no collected panel must not report it. A panel never collected
-- at all is its own number, because it is its own failure — a collector that
-- never started on it, not one that stopped.
--
-- Additive. Rollback: `DROP FUNCTION network.collection_watchdog()`.

CREATE FUNCTION network.collection_watchdog()
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
$$;

REVOKE ALL ON FUNCTION network.collection_watchdog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION network.collection_watchdog() TO txnet_app;
