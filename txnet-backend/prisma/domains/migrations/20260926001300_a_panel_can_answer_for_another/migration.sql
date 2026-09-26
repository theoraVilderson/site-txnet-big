-- F-027-cf — a collector pass that finds another panel's clients on a panel
-- (ADR-0090 decision 1, D-48) raises a halting drift event of its own type.
--
-- Its own migration: Postgres does not let a value added to an enum be used
-- in the transaction that added it, and the next migration's CHECK names it.
--
-- Additive. Rollback: a value cannot be dropped from a Postgres enum; a
-- rollback that must remove it recreates the type.

ALTER TYPE "network"."PanelDriftEventType" ADD VALUE 'foreign_claim';
