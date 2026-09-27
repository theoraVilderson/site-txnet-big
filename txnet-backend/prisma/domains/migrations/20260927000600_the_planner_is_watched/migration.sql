-- F-027-dm — the lease planner's numbers that already live on a row, read by
-- postgres-exporter (SPEC §10).
--
-- Same reason as `network.collection_watchdog()` (20260922000400): the
-- exporter connects as `txnet_app_user`, which under RLS sees the platform's
-- panels and none of a tenant's. Two `SECURITY DEFINER` functions answer
-- numbers per panel and per panel family, and never a tenant or a Grant id.
-- The planner's in-process counters (writes by reason, false-cut seconds) are
-- not here: they are `/metrics` on network-service.
--
-- `planner_panels()`: one row per panel in the watchdog's scope. Lag is the
-- planner's learned `lagMeanSec` and the square root of `lagVarianceSec2`, -1
-- while it has no sample. `tick_known` mirrors `quota.TickClock.Known`: a
-- phase mask is saved and at most a quarter of its 32 bins are still set; a
-- panel with no mask saved has not been pinned.
--
-- `planner_overshoot()`: per family, the Grants the planner closed between 5
-- minutes and 7 days ago. Overshoot is (served − quota at close) / quota at
-- close, signed: below zero the close left bytes behind. Served is every
-- config's lifetime counter, as the planner's own read sums it. The 5 minutes
-- let the last tick's traffic land; the count is bounded by the window. A
-- Grant whose configs sit on two families is `mixed`.
--
-- Additive. Rollback: drop both functions.

CREATE FUNCTION network.planner_panels()
  RETURNS TABLE (panel text, family text, lag_mean_seconds float8, lag_stddev_seconds float8,
                 lag_samples bigint, tick_known bigint)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    p.id::text,
    p."driverType"::text,
    COALESCE(p."lagMeanSec", -1)::float8,
    COALESCE(sqrt(p."lagVarianceSec2"), -1)::float8,
    p."lagSamples"::bigint,
    (p."tickPhaseMask" IS NOT NULL AND p."tickPhaseMask" <> 0
      AND bit_count(p."tickPhaseMask"::bit(32)) <= 8)::int::bigint
  FROM network.panel p
  WHERE p."reviewState" IN ('accepted', 'accepted_low_trust')
    AND p."panelState" <> 'maintenance'
    AND p."retiredAt" IS NULL
$$;

CREATE FUNCTION network.planner_overshoot()
  RETURNS TABLE (family text, closed_grants bigint, overshoot_ratio_p50 float8,
                 overshoot_ratio_p95 float8, overshoot_ratio_max float8)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH closed AS (
    SELECT lc."grantId",
           lc."quotaBytes",
           CASE WHEN COUNT(DISTINCT p."driverType") = 1 THEN MIN(p."driverType"::text) ELSE 'mixed' END AS family,
           COALESCE(SUM(s."lifetimeUpBytes" + s."lifetimeDownBytes"), 0) AS served
      FROM network.lease_close lc
      JOIN network.config c ON c."grantId" = lc."grantId"
      JOIN network.panel p ON p.id = c."panelId"
      LEFT JOIN network.config_counter_state s ON s."configId" = c.id
     WHERE lc."closedAt" BETWEEN now() - interval '7 days' AND now() - interval '5 minutes'
       AND lc."quotaBytes" > 0
     GROUP BY lc."grantId", lc."quotaBytes"
  )
  SELECT family,
         COUNT(*)::bigint,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY (served - "quotaBytes")::float8 / "quotaBytes"),
         percentile_cont(0.95) WITHIN GROUP (ORDER BY (served - "quotaBytes")::float8 / "quotaBytes"),
         MAX((served - "quotaBytes")::float8 / "quotaBytes")
    FROM closed
   GROUP BY family
$$;

REVOKE ALL ON FUNCTION network.planner_panels() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION network.planner_panels() TO txnet_app;
REVOKE ALL ON FUNCTION network.planner_overshoot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION network.planner_overshoot() TO txnet_app;
