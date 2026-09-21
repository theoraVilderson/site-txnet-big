-- F-027-ak — `network.traffic_raw_log` is policied like the rest (F-1202).
--
-- F-027-e (20260921000500) gave this table a `tenantId` for the first time and
-- recreated it as partitioned. `20260909001500_row_level_security_all_tables`
-- could not have covered it: on that day the table had no tenant column and
-- was not tenant-scoped at all. So it came out of F-027-e as the only one of
-- 41 tenant-scoped tables named by no policy anywhere in the history, which is
-- what `rls-coverage.spec.ts` has been red about since.
--
-- 1. List A (strict), not list B. `tenantId` is `NOT NULL` here: there is no
--    platform-wide traffic row and NULL means nothing, so the app pool reads
--    strictly its own — `"tenantId" = current_tenant_id()` on both sides.
-- 2. **The partitions carry their own policies.** A policy on a partitioned
--    parent governs a query that names the parent; a query naming
--    `traffic_raw_log_2026_10` directly is judged by that partition's own
--    policies, and a partition with none is a readable copy of a protected
--    table under a name anyone can derive from the month. Nothing in this repo
--    queries a partition directly today, and that is exactly the assumption
--    that stops being true the first time someone writes a maintenance script.
-- 3. `ensure_traffic_raw_log_partition()` policies what it creates. It runs
--    every month, forever; a creator that does not policy re-opens this gap on
--    a clock, in whichever month nobody was looking.
--
-- Additive: no table, column or row changes. Rollback is dropping the two
-- policies from the parent and its partitions, though a rollback here is
-- re-opening a tenant-isolation hole and wants a reason.

-- -----------------------------------------------------------------------------
-- The parent and the months already created
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'network.traffic_raw_log',
    'network.traffic_raw_log_2026_09',
    'network.traffic_raw_log_2026_10',
    'network.traffic_raw_log_2026_11',
    'network.traffic_raw_log_2026_12',
    'network.traffic_raw_log_2027_01',
    'network.traffic_raw_log_2027_02'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);

    EXECUTE format('DROP POLICY IF EXISTS cross_tenant ON %s', t);
    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- Every month created from here on carries the same policies
-- -----------------------------------------------------------------------------
-- Otherwise the repair above is a one-off and the gap returns on the 1st of
-- some month, with a green test suite over it. Still idempotent: the nightly
-- job calls this for the next two months without knowing which already exists.
CREATE OR REPLACE FUNCTION "network"."ensure_traffic_raw_log_partition"(a_month DATE)
RETURNS TEXT
LANGUAGE plpgsql
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
