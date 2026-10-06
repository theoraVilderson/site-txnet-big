-- F-027-ek — the collector reports on itself (ADR-0122).
--
-- On 2026-10-03 the dev collector's binary exited and nothing noticed:
-- `panelState` simply stopped moving, and a panel read `healthy` for three
-- days. The per-panel watchdog (F-027-w) cannot tell that apart from every
-- panel failing at once, so it blames each of them. One row per collector
-- instance, upserted every bulk pass, says whether the collector is running
-- at all, and `egress` says whether the last pass could reach the world.
--
-- `network.collector_watchdog()` is SECURITY DEFINER for the exporter, as
-- `network.collection_watchdog()` is: -1 seconds when no pass was ever
-- recorded, and `egress_ok` 0 while the freshest row says our reach is not ok.
--
-- Additive. Rollback: drop the function, the table and the type.

CREATE TYPE "network"."CollectorEgress" AS ENUM ('ok', 'down', 'dns_down', 'suspect');

CREATE TABLE "network"."collector_heartbeat" (
    "instance" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "passAt" TIMESTAMP(3) NOT NULL,
    "panelsAsked" INTEGER NOT NULL,
    "panelsFailed" INTEGER NOT NULL,
    "egress" "network"."CollectorEgress" NOT NULL,
    "egressSince" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collector_heartbeat_pkey" PRIMARY KEY ("instance")
);

CREATE FUNCTION network.collector_watchdog()
  RETURNS TABLE (seconds_since_pass float8, egress_ok int)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    COALESCE(EXTRACT(EPOCH FROM (now() - MAX(h."passAt"))), -1)::float8,
    COALESCE((SELECT (f.egress = 'ok')::int FROM network.collector_heartbeat f
               ORDER BY f."passAt" DESC LIMIT 1), 1)
  FROM network.collector_heartbeat h
$$;

REVOKE ALL ON FUNCTION network.collector_watchdog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION network.collector_watchdog() TO txnet_app;
