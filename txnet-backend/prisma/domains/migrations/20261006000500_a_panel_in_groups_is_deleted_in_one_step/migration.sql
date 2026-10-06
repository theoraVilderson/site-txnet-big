-- F-027-eg — deleting a panel still in groups is one step: its memberships
-- are evicted with the owner's choice for their users, and the drain sweep
-- archives it once it is out of every group and its clients are gone
-- (billing `contract.panel-lifecycle.md`).
--
-- `panel.removeRequestedAt`: when that was asked. Cleared by the archive.
-- CHECK: never on an archived panel.
--
-- Additive, nullable, no row has it. Rollback: drop the CHECK and the column.

ALTER TABLE "network"."panel" ADD COLUMN "removeRequestedAt" TIMESTAMP(3);

ALTER TABLE "network"."panel"
  ADD CONSTRAINT "panel_remove_requested_is_not_retired"
  CHECK ("removeRequestedAt" IS NULL OR "retiredAt" IS NULL);
