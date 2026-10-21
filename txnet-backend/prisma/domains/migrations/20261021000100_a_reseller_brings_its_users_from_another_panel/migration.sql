-- F-201-a (D-63): the tables a reseller's import runs on.
--
--   migration_run  — one import: a whole source panel, one old link or a
--                    balances CSV; its state, the dry run's counts, the
--                    commit's progress and its rollback window.
--   migration_item — one source client in a run: the snapshot as read (the
--                    source state F-211 restores from), the planned action,
--                    the outcome and what the commit created.
--   grant.remoteIdentity — the import's idempotency key (F-207): unique per
--                    tenant, only on a `migration` Grant.
--
-- Nothing outside the two tables is written before a commit (catalog hard
-- rule). Strict tenant RLS on both; an item is its run's tenant's by a
-- composite foreign key. Additive; rollback: remove both tables and their
-- five types, then the Grant's unique index, its CHECK and its column.

CREATE TYPE "entitlement"."MigrationRunKind" AS ENUM ('panel', 'link', 'csv');
CREATE TYPE "entitlement"."MigrationRunStatus" AS ENUM ('draft', 'previewing', 'previewed', 'committing', 'committed', 'rolled_back', 'cancelled', 'expired');
CREATE TYPE "entitlement"."MigrationItemAction" AS ENUM ('create', 'update', 'skip');
CREATE TYPE "entitlement"."MigrationSkipReason" AS ENUM ('expired', 'duplicate', 'over_cap', 'unknown_protocol');
CREATE TYPE "entitlement"."MigrationItemOutcome" AS ENUM ('pending', 'created', 'updated', 'skipped', 'failed', 'rolled_back');

CREATE TABLE "entitlement"."migration_run" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "entitlement"."MigrationRunKind" NOT NULL,
    "sourceFamily" "network"."DriverType",
    "sourceAddress" TEXT,
    "status" "entitlement"."MigrationRunStatus" NOT NULL DEFAULT 'draft',
    "plannedCreate" INTEGER NOT NULL DEFAULT 0,
    "plannedUpdate" INTEGER NOT NULL DEFAULT 0,
    "plannedSkip" INTEGER NOT NULL DEFAULT 0,
    "committedItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "rollbackUntil" TIMESTAMP(3),
    "actorUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "migration_run_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "migration_run_counts_not_negative" CHECK (
        "plannedCreate" >= 0 AND "plannedUpdate" >= 0 AND "plannedSkip" >= 0
        AND "committedItems" >= 0 AND "failedItems" >= 0),
    -- A panel run names its family and address, a link run its address, a CSV
    -- run neither: the source is what the item snapshots were read from.
    CONSTRAINT "migration_run_source_fits_kind" CHECK (
        ("kind" = 'panel' AND "sourceFamily" IS NOT NULL AND "sourceAddress" IS NOT NULL)
        OR ("kind" = 'link' AND "sourceFamily" IS NULL AND "sourceAddress" IS NOT NULL)
        OR ("kind" = 'csv' AND "sourceFamily" IS NULL AND "sourceAddress" IS NULL)),
    -- The window opens at the commit (D-63: 7 days); a run never committed has none.
    CONSTRAINT "migration_run_rollback_after_commit" CHECK (
        "rollbackUntil" IS NULL OR "status" IN ('committed', 'rolled_back'))
);

CREATE UNIQUE INDEX "migration_run_id_tenantId_key" ON "entitlement"."migration_run"("id", "tenantId");
CREATE INDEX "migration_run_tenantId_createdAt_idx" ON "entitlement"."migration_run"("tenantId", "createdAt");

CREATE TABLE "entitlement"."migration_item" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "remoteIdentity" TEXT NOT NULL,
    "sourceSnapshot" JSONB NOT NULL,
    "plannedAction" "entitlement"."MigrationItemAction" NOT NULL,
    "skipReason" "entitlement"."MigrationSkipReason",
    "outcome" "entitlement"."MigrationItemOutcome" NOT NULL DEFAULT 'pending',
    "failureReason" TEXT,
    "createdUserId" UUID,
    "createdGrantId" UUID,
    "createdConfigIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "migration_item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "migration_item_remote_identity_not_blank" CHECK (btrim("remoteIdentity") <> ''),
    CONSTRAINT "migration_item_skip_has_reason" CHECK (("plannedAction" = 'skip') = ("skipReason" IS NOT NULL))
);

CREATE UNIQUE INDEX "migration_item_runId_remoteIdentity_key" ON "entitlement"."migration_item"("runId", "remoteIdentity");
CREATE INDEX "migration_item_runId_plannedAction_idx" ON "entitlement"."migration_item"("runId", "plannedAction");
CREATE INDEX "migration_item_tenantId_idx" ON "entitlement"."migration_item"("tenantId");

ALTER TABLE "entitlement"."migration_item" ADD CONSTRAINT "migration_item_runId_tenantId_fkey"
    FOREIGN KEY ("runId", "tenantId") REFERENCES "entitlement"."migration_run"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- The import's idempotency key on the Grant (F-207)
-- -----------------------------------------------------------------------------
ALTER TABLE "entitlement"."grant" ADD COLUMN "remoteIdentity" TEXT;
ALTER TABLE "entitlement"."grant" ADD CONSTRAINT "grant_remote_identity_is_migration" CHECK (
    "remoteIdentity" IS NULL OR ("source" = 'migration' AND btrim("remoteIdentity") <> ''));
CREATE UNIQUE INDEX "grant_tenantId_remoteIdentity_key" ON "entitlement"."grant"("tenantId", "remoteIdentity");

-- -----------------------------------------------------------------------------
-- A run's status moves forward. Two moves back, both before anything is
-- written outside the run: a snapshot that failed returns to `draft`, and a
-- previewed run whose mapping changed is previewed again. A committed run only
-- rolls back; it is never committed twice.
-- -----------------------------------------------------------------------------
CREATE FUNCTION entitlement.migration_run_status_moves() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = OLD."status"
     OR (OLD."status" = 'draft'      AND NEW."status" IN ('previewing', 'cancelled', 'expired'))
     OR (OLD."status" = 'previewing' AND NEW."status" IN ('previewed', 'draft', 'cancelled'))
     OR (OLD."status" = 'previewed'  AND NEW."status" IN ('previewing', 'committing', 'cancelled', 'expired'))
     OR (OLD."status" = 'committing' AND NEW."status" IN ('committed'))
     OR (OLD."status" = 'committed'  AND NEW."status" IN ('rolled_back')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'migration_run_status_moves: % -> % is not a move a run makes', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER migration_run_status_moves BEFORE UPDATE OF "status" ON "entitlement"."migration_run"
  FOR EACH ROW EXECUTE FUNCTION entitlement.migration_run_status_moves();

-- -----------------------------------------------------------------------------
-- Tenant data
-- -----------------------------------------------------------------------------
ALTER TABLE entitlement.migration_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.migration_run FORCE ROW LEVEL SECURITY;
ALTER TABLE entitlement.migration_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.migration_item FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement"."migration_run", "entitlement"."migration_item" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "entitlement"."migration_run"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "entitlement"."migration_run"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

CREATE POLICY tenant_isolation ON "entitlement"."migration_item"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "entitlement"."migration_item"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
