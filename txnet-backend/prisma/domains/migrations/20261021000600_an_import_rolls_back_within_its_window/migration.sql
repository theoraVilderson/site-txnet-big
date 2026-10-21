-- F-211 (D-63): a committed import may be rolled back for 7 days, and the
-- source state it kept is purged when that window ends.
--
--   MigrationRunStatus.rolling_back — the reseller asked; the worker undoes
--                    the run a batch a tick, as the commit did it.
--   migration_run.rollbackActorUserId — who asked (no FK: may be staff).
--   migration_run.snapshotsPurgedAt — when the window ended and the items'
--                    snapshots were cleared; null while they are kept.
--   MigrationItemOutcome.kept — a customer who renewed, topped up or bought
--                    since the import: the rollback leaves the item as it is.
--   migration_item.keptReason — why it was kept (`renewed`, `topped_up`,
--                    `bought`, …), or on a rolled-back item why its person
--                    stayed (`signed_in`, `holds_other_service`, …).
--   migration_item.rolledBackAt — the rollback is done with the item, its
--                    person included; null until then.
--   migration_item.sourceSnapshot — nullable: the purge clears it.
--
-- The new enum values are compared as text in this file: Postgres refuses a
-- new value used in the transaction that added it. Additive; rollback: drop
-- the four columns, restore the CHECK and the trigger function below, set the
-- snapshot NOT NULL again (the enum values stay: Postgres cannot drop one).

ALTER TYPE "entitlement"."MigrationRunStatus" ADD VALUE 'rolling_back';
ALTER TYPE "entitlement"."MigrationItemOutcome" ADD VALUE 'kept';

ALTER TABLE "entitlement"."migration_run"
  ADD COLUMN "rollbackActorUserId" UUID,
  ADD COLUMN "snapshotsPurgedAt" TIMESTAMP(3);

ALTER TABLE "entitlement"."migration_item"
  ADD COLUMN "keptReason" TEXT,
  ADD COLUMN "rolledBackAt" TIMESTAMP(3);

ALTER TABLE "entitlement"."migration_item" ALTER COLUMN "sourceSnapshot" DROP NOT NULL;

-- The window stays on the run while it is rolled back and after.
ALTER TABLE "entitlement"."migration_run" DROP CONSTRAINT "migration_run_rollback_after_commit";
ALTER TABLE "entitlement"."migration_run" ADD CONSTRAINT "migration_run_rollback_after_commit" CHECK (
  "rollbackUntil" IS NULL OR "status"::text IN ('committed', 'rolling_back', 'rolled_back'));

-- Only a run someone asked to roll back names who asked.
ALTER TABLE "entitlement"."migration_run" ADD CONSTRAINT "migration_run_rollback_has_actor" CHECK (
  "rollbackActorUserId" IS NULL OR "status"::text IN ('rolling_back', 'rolled_back'));

-- A kept item says why; a reason is written only when the rollback is done with the item.
ALTER TABLE "entitlement"."migration_item" ADD CONSTRAINT "migration_item_kept_has_reason" CHECK (
  ("outcome"::text <> 'kept' OR "keptReason" IS NOT NULL)
  AND ("keptReason" IS NULL OR "rolledBackAt" IS NOT NULL));

-- A committed run is undone through `rolling_back`, never in one step.
CREATE OR REPLACE FUNCTION entitlement.migration_run_status_moves() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = OLD."status"
     OR (OLD."status"::text = 'draft'        AND NEW."status"::text IN ('previewing', 'cancelled', 'expired'))
     OR (OLD."status"::text = 'previewing'   AND NEW."status"::text IN ('previewed', 'draft', 'cancelled'))
     OR (OLD."status"::text = 'previewed'    AND NEW."status"::text IN ('previewing', 'committing', 'cancelled', 'expired'))
     OR (OLD."status"::text = 'committing'   AND NEW."status"::text IN ('committed'))
     OR (OLD."status"::text = 'committed'    AND NEW."status"::text IN ('rolling_back'))
     OR (OLD."status"::text = 'rolling_back' AND NEW."status"::text IN ('rolled_back')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'migration_run_status_moves: % -> % is not a move a run makes', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END
$$;
