-- F-027-e — the storage shape `traffic_raw_log` was declared with in
-- 20260908000000_init and never given.
--
-- `data-model.md` has carried "native monthly partitioning, BRIN on
-- `recordedAt`, section 99 manual SQL — not applied" since the schema was
-- written, and invariant 2 ("only ever appended and dropped by partition,
-- never DELETEd row-wise") has had no mechanism behind it. Prisma cannot
-- express partitioning, a BRIN index or a per-month table, so this file is
-- hand-written and lives in the same history as the generated ones.
--
-- Four things, one argument:
--
-- 1. **Monthly range partitioning on `recordedAt`.** Retention here is
--    `DROP PARTITION`: the nightly rollup computes `traffic_daily_aggregate`
--    and the month's raw rows then go in one catalogue operation. Row-wise
--    `DELETE` over the highest-volume table in the platform is the vacuum
--    bloat the schema comment was written to avoid, and it competes with the
--    collection loop for the same pages.
-- 2. **`(id, recordedAt)` as the primary key.** Postgres requires the
--    partition key in every unique constraint on a partitioned table, so a
--    bare `BIGSERIAL` id is the one shape this table cannot have. The
--    sequence still issues the id; what changes is that uniqueness is
--    enforced per partition, which for an append-only log is the same
--    guarantee in practice.
-- 3. **`tenantId`, denormalized.** Exactly as `config.tenantId` is
--    (invariant 6). The reporting read is per tenant, and reaching the tenant
--    through `config` is a join against the largest table in the schema on
--    every query.
-- 4. **A unique `(configId, date)` on `traffic_daily_aggregate`.** The rollup
--    had no unique key at all, so a cron rerun — a retry, an operator
--    re-running last night — wrote a second row for the same day and doubled
--    the reported usage. Both rows are individually correct, which is what
--    makes it invisible; the constraint turns the rerun into an upsert
--    target.
--
-- There is deliberately **no `DEFAULT` partition.** It is the one partition
-- that can never be dropped, so rows for a month nobody created would live in
-- it forever and the retention story above would quietly stop covering them.
-- A missing month is an insert error instead: loud, and the delta it came from
-- goes to quarantine rather than nowhere (invariant 18). Six months are
-- created here and `network.ensure_traffic_raw_log_partition(date)` rolls the
-- rest forward — idempotent, so the nightly job calls it blindly.
--
-- DESTRUCTIVE in form: an existing table cannot be converted to a partitioned
-- one in place, so it is dropped and recreated. Safe to be, for the reason
-- 20260921000100 gave: no service reads or writes this schema (`source: []`)
-- and both tables have never been written. Asserted below rather than
-- assumed, because a dropped table cannot be undone by the next migration.
--
-- Rollback: drop the partitioned table with its partitions and the function,
-- recreate `traffic_raw_log` as 20260908000000_init declares it (no
-- `tenantId`, `PRIMARY KEY ("id")`), and drop the unique index on
-- `traffic_daily_aggregate`. The rollback expires with the first row.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM network.traffic_raw_log) THEN
    RAISE EXCEPTION 'network.traffic_raw_log has rows; F-027-e recreates the table as partitioned and cannot carry them over';
  END IF;
  IF EXISTS (SELECT 1 FROM network.traffic_daily_aggregate) THEN
    RAISE EXCEPTION 'network.traffic_daily_aggregate has rows; F-027-e adds a unique key that existing rows may already violate';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- The raw log, rebuilt as a partitioned table
-- -----------------------------------------------------------------------------
DROP TABLE "network"."traffic_raw_log";

CREATE TABLE "network"."traffic_raw_log" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "configId" UUID NOT NULL,
    "uploadBytes" BIGINT NOT NULL,
    "downloadBytes" BIGINT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traffic_raw_log_pkey" PRIMARY KEY ("id", "recordedAt")
) PARTITION BY RANGE ("recordedAt");

-- One config's traffic over a window — the user-facing usage chart.
CREATE INDEX "traffic_raw_log_configId_recordedAt_idx" ON "network"."traffic_raw_log"("configId", "recordedAt");
-- The tenant-wide reporting read, without the join to `config`.
CREATE INDEX "traffic_raw_log_tenantId_recordedAt_idx" ON "network"."traffic_raw_log"("tenantId", "recordedAt");
-- BRIN, not a B-tree ("section 18"): the table is append-only, so its
-- physical order already follows `recordedAt`, and the summary is a fraction
-- of the size — which at this volume is paid back on every single insert.
CREATE INDEX "traffic_raw_log_recordedAt_brin_idx" ON "network"."traffic_raw_log" USING BRIN ("recordedAt");

ALTER TABLE "network"."traffic_raw_log"
    ADD CONSTRAINT "traffic_raw_log_configId_fkey" FOREIGN KEY ("configId") REFERENCES "network"."config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Rolling the months forward
-- -----------------------------------------------------------------------------
-- Idempotent: the nightly job calls it for the next two months without
-- knowing which of them already exists. A table with no partition for next
-- month stops accepting traffic at midnight on the 1st, so this is not a
-- one-off piece of setup.
CREATE OR REPLACE FUNCTION "network"."ensure_traffic_raw_log_partition"(a_month DATE)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_from DATE := date_trunc('month', a_month)::date;
  v_to   DATE := (date_trunc('month', a_month) + INTERVAL '1 month')::date;
  v_name TEXT := 'traffic_raw_log_' || to_char(v_from, 'YYYY_MM');
BEGIN
  IF to_regclass('network.' || quote_ident(v_name)) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
      'network', v_name, 'network', 'traffic_raw_log', v_from, v_to);
  END IF;
  RETURN v_name;
END
$$;

-- The months in hand at migration time. Everything after them is the
-- function's job, and a month that was never created is an insert error, not
-- a row in a partition nobody drops.
CREATE TABLE "network"."traffic_raw_log_2026_09" PARTITION OF "network"."traffic_raw_log"
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "network"."traffic_raw_log_2026_10" PARTITION OF "network"."traffic_raw_log"
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "network"."traffic_raw_log_2026_11" PARTITION OF "network"."traffic_raw_log"
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "network"."traffic_raw_log_2026_12" PARTITION OF "network"."traffic_raw_log"
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE "network"."traffic_raw_log_2027_01" PARTITION OF "network"."traffic_raw_log"
    FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "network"."traffic_raw_log_2027_02" PARTITION OF "network"."traffic_raw_log"
    FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');

-- -----------------------------------------------------------------------------
-- One rollup row per config per day
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX "traffic_daily_aggregate_config_date_key" ON "network"."traffic_daily_aggregate"("configId", "date");
