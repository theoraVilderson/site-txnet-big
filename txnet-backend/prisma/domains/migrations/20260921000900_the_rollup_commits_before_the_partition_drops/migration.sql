-- F-027-o — the nightly rollup, and the ordering it exists to hold.
--
-- Network invariant 3 — *the daily aggregate is computed before its source raw
-- partition is dropped* — has read "planned cron ordering" since the schema was
-- written. F-027-e (20260921000500) built the partitioning the invariant is
-- about and left the job itself for this row. Backwards, the loss is permanent
-- and silent: `DROP TABLE` on a partition leaves nothing to recompute from, and
-- the month reads as zero traffic ever after.
--
-- Three functions, and the argument for each:
--
-- 1. **`roll_up_traffic(from, to)` — one `INSERT … SELECT`, not a loop in
--    Node.** The rollup reads the highest-volume table in the platform and
--    writes one row per `(configId, date)`; pulling the raw rows across the
--    wire to sum them in a process is the same answer for several orders of
--    magnitude more work. `ON CONFLICT … DO UPDATE` **replaces** the day's
--    totals rather than adding to them, so a rerun — a retry, an operator
--    re-running last night, the job's own overlapping window — is the same
--    answer, and a row that arrived after an earlier rollup is picked up by
--    the next one (invariant 30's unique key is what makes this an upsert
--    target at all).
--
-- 2. **`drop_traffic_raw_log_partition(month)` refuses.** The ordering is not
--    left to the order of two statements in a job, because a job is where it
--    would be got wrong. The function counts the `(configId, date)` groups in
--    the partition whose `traffic_daily_aggregate` row is missing **or does
--    not match**, and raises rather than dropping if there are any. Equality,
--    not existence: a stale aggregate — rolled up before the month's last
--    rows landed — is exactly the failure that looks fine afterwards, because
--    both the row and the dropped partition are individually plausible. It
--    also refuses the current and any future month outright.
--
-- 3. **All three are `SECURITY DEFINER`.** Two reasons, and neither is
--    convenience. `traffic_raw_log` carries FORCE RLS since F-027-ak and its
--    policies are `TO txnet_app` / `TO txnet_cross_tenant`, so the rollup —
--    which is platform-wide by definition and binds no `app.tenant_id` —
--    reads nothing at all as the application role; this is the same argument
--    `billing.coupons_over_limit()` (20260914000600) makes for the exporter.
--    And creating or dropping a partition is DDL: `txnet_app` holds
--    `SELECT, INSERT, UPDATE, DELETE` and no `CREATE` on `network`
--    (20260909000500), so `ensure_traffic_raw_log_partition` has in fact never
--    been callable by the job it was written for. It is recreated here with
--    the F-027-ak body unchanged — it must still policy every partition it
--    creates, which `rls-coverage.spec.ts` asserts — plus the definer rights
--    and the grant.
--
-- Additive: no table, column or row changes, and `traffic_daily_aggregate` is
-- only ever written by the first function. Rollback is dropping the two new
-- functions and recreating the third without `SECURITY DEFINER`; the retention
-- story then has no mechanism again.

-- -----------------------------------------------------------------------------
-- The rollup
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "network"."roll_up_traffic"(a_from DATE, a_to DATE)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = network, public, pg_temp
AS $$
DECLARE
  v_rows BIGINT;
BEGIN
  IF a_to <= a_from THEN
    RAISE EXCEPTION 'roll_up_traffic: a_to (%) must be after a_from (%)', a_to, a_from;
  END IF;

  -- `userId` is carried from `config` rather than from the raw row, which does
  -- not have one: the aggregate is read per user, and a config's owner is the
  -- only place that answer exists.
  INSERT INTO "network"."traffic_daily_aggregate"
      ("id", "userId", "configId", "date", "totalUploadBytes", "totalDownloadBytes")
  SELECT gen_random_uuid(),
         c."userId",
         r."configId",
         r."recordedAt"::date,
         sum(r."uploadBytes"),
         sum(r."downloadBytes")
    FROM "network"."traffic_raw_log" r
    JOIN "network"."config" c ON c."id" = r."configId"
   WHERE r."recordedAt" >= a_from
     AND r."recordedAt" <  a_to
   GROUP BY c."userId", r."configId", r."recordedAt"::date
  ON CONFLICT ("configId", "date") DO UPDATE
     SET "totalUploadBytes"   = EXCLUDED."totalUploadBytes",
         "totalDownloadBytes" = EXCLUDED."totalDownloadBytes",
         "userId"             = EXCLUDED."userId";

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$$;

GRANT EXECUTE ON FUNCTION "network"."roll_up_traffic"(DATE, DATE) TO txnet_app;

-- -----------------------------------------------------------------------------
-- The drop, which checks the rollup committed first
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "network"."drop_traffic_raw_log_partition"(a_month DATE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = network, public, pg_temp
AS $$
DECLARE
  v_from       DATE := date_trunc('month', a_month)::date;
  v_to         DATE := (date_trunc('month', a_month) + INTERVAL '1 month')::date;
  v_name       TEXT := 'traffic_raw_log_' || to_char(v_from, 'YYYY_MM');
  v_full       TEXT := format('%I.%I', 'network', v_name);
  v_uncovered  BIGINT;
BEGIN
  -- No partition is not an error: it is what a rerun of last night's drop
  -- looks like, and the caller asks blindly.
  IF to_regclass('network.' || quote_ident(v_name)) IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_to > date_trunc('month', CURRENT_DATE)::date THEN
    RAISE EXCEPTION
      'network.% is the current or a future month; its traffic is still arriving', v_name;
  END IF;

  -- The invariant, as a query: every (configId, date) group in this partition
  -- must have an aggregate row, and it must agree. A missing row is a month
  -- never rolled up; a differing one is a rollup that ran before the month's
  -- last rows landed.
  EXECUTE format($q$
    SELECT count(*)
      FROM (
        SELECT r."configId" AS config_id,
               r."recordedAt"::date AS day,
               sum(r."uploadBytes") AS up,
               sum(r."downloadBytes") AS down
          FROM %s r
         GROUP BY 1, 2
      ) raw
      LEFT JOIN "network"."traffic_daily_aggregate" a
             ON a."configId" = raw.config_id
            AND a."date"     = raw.day
     WHERE a."id" IS NULL
        OR a."totalUploadBytes"   <> raw.up
        OR a."totalDownloadBytes" <> raw.down
  $q$, v_full)
  INTO v_uncovered;

  IF v_uncovered > 0 THEN
    RAISE EXCEPTION
      'network.% has % (configId, date) group(s) with no matching traffic_daily_aggregate row; the rollup commits before its source partition is dropped (network invariant 3)',
      v_name, v_uncovered;
  END IF;

  -- `DROP TABLE` on a partition detaches it on the way out; a separate DETACH
  -- would leave a standalone table behind if the drop then failed.
  EXECUTE format('DROP TABLE %s', v_full);
  RETURN v_name;
END
$$;

GRANT EXECUTE ON FUNCTION "network"."drop_traffic_raw_log_partition"(DATE) TO txnet_app;

-- -----------------------------------------------------------------------------
-- The creator, now callable by the job it was written for
-- -----------------------------------------------------------------------------
-- The body is F-027-ak's, unchanged: it must still policy every partition it
-- creates, or the gap that migration closed re-opens on a clock. What is added
-- is `SECURITY DEFINER` and the grant — without them `txnet_app` cannot
-- `CREATE TABLE` in `network` and the nightly call fails on the one night of
-- the month that matters.
CREATE OR REPLACE FUNCTION "network"."ensure_traffic_raw_log_partition"(a_month DATE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = network, public, pg_temp
AS $$
DECLARE
  v_from DATE := date_trunc('month', a_month)::date;
  v_to   DATE := (date_trunc('month', a_month) + INTERVAL '1 month')::date;
  v_name TEXT := 'traffic_raw_log_' || to_char(v_from, 'YYYY_MM');
  v_full TEXT := format('%I.%I', 'network', v_name);
BEGIN
  IF to_regclass('network.' || quote_ident(v_name)) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
      'network', v_name, 'network', 'traffic_raw_log', v_from, v_to);
  END IF;

  -- Outside the IF: a partition created before this function knew to policy
  -- one is repaired the next time the job runs over it, rather than staying
  -- open until someone notices.
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_full);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', v_full);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', v_full);

  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', v_full);
  EXECUTE format($p$
    CREATE POLICY tenant_isolation ON %s
      AS PERMISSIVE FOR ALL TO txnet_app
      USING ("tenantId" = public.current_tenant_id())
      WITH CHECK ("tenantId" = public.current_tenant_id())
  $p$, v_full);

  EXECUTE format('DROP POLICY IF EXISTS cross_tenant ON %s', v_full);
  EXECUTE format($p$
    CREATE POLICY cross_tenant ON %s
      AS PERMISSIVE FOR ALL TO txnet_cross_tenant
      USING (true) WITH CHECK (true)
  $p$, v_full);

  RETURN v_name;
END
$$;

GRANT EXECUTE ON FUNCTION "network"."ensure_traffic_raw_log_partition"(DATE) TO txnet_app;
