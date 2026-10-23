-- F-1601-b1 — an import read in place (ADR-0160): a run names the tenant's
-- registered panel instead of an address and a source login, and the
-- snapshot is read with that panel's own login. Only a panel run does: a link
-- or CSV run names no panel. No foreign key — `network.panel` is another
-- domain's, and the run is a record kept after the panel may be retired; the
-- service checks it is the tenant's, accepted and of the run's family.
--
-- `no_inbound`: a client on no source inbound — a User Manager user holding
-- no profile, which cannot log in there — is skipped rather than left as an
-- inbound nobody can map.
--
-- Expand only: one nullable column, one CHECK, one enum value.
-- Rollback: drop the CHECK and the column; the enum value stays (unused).

ALTER TYPE "entitlement"."MigrationSkipReason" ADD VALUE 'no_inbound';

ALTER TABLE "entitlement"."migration_run" ADD COLUMN "sourcePanelId" UUID;

ALTER TABLE "entitlement"."migration_run" ADD CONSTRAINT "migration_run_in_place_is_a_panel_run"
    CHECK ("sourcePanelId" IS NULL OR "kind" = 'panel');
