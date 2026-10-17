-- F-027-et — moving a Grant to another panel group (ADR-0127 decision 5):
-- only `grant.panelGroupId` changes; a config the target also sells where it
-- is stays, the rest are moved by the target's fulfilment. One Grant is a
-- route; many are a kind of F-311-ad's config move job, `to_group`, so the
-- drain, outcomes and progress event are that job's. An item of a `to_group`
-- job names a Grant: `config_move_job_item.configId` holds its id (the column
-- has no foreign key; the item key and the drain's order are unchanged).
--
-- `toGroupId` is the target; no foreign key — the job is a record kept after
-- the group may be gone. `grant_group_move` is the Grant's own audit row.
--
-- Expand only: two enum values, one nullable column, the kind CHECK widened.
-- The CHECK compares the new value as text: a value added in this
-- transaction cannot be used as an enum literal before it commits.
-- Rollback: the CHECK as 20261017000500 wrote it once no `to_group` job
-- exists, then drop the column; enum values stay (unused).

ALTER TYPE "network"."ConfigMoveJobKind" ADD VALUE 'to_group';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_group_move';

ALTER TABLE "network"."config_move_job"
  ADD COLUMN "toGroupId" UUID,
  DROP CONSTRAINT "config_move_job_kind_fits",
  ADD CONSTRAINT "config_move_job_kind_fits" CHECK (
    ("kind" = 'to_panel' AND "toPanelId" IS NOT NULL AND "orphans" IS NULL AND "toGroupId" IS NULL)
    OR ("kind" = 'release_move' AND "toPanelId" IS NULL AND "orphans" IS NULL AND "toGroupId" IS NULL)
    OR ("kind" = 'release_empty' AND "toPanelId" IS NULL AND "orphans" IS NOT NULL AND "toGroupId" IS NULL)
    OR ("kind"::text = 'to_group' AND "toPanelId" IS NULL AND "orphans" IS NULL AND "toGroupId" IS NOT NULL));
