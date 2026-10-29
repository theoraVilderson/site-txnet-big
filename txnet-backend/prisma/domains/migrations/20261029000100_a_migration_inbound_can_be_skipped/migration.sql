-- LIVE-1-h (2026-10-29, the user's call): a reseller may leave a source
-- inbound out of an import on purpose. Until now `variantId` null meant both
-- "not chosen yet" and "none", and an inbound with clients and no variant
-- sent the dry run back to draft — so a test inbound with five users blocked
-- the whole run. `skipped` is the explicit "do not import"; its clients are
-- planned `inbound_skipped`. A skip never carries a variant.
-- Additive: a column with a default, an enum value, a CHECK every row meets.
-- Rollback: drop the CHECK and the column (the enum value stays unused).

ALTER TABLE "entitlement"."migration_inbound"
  ADD COLUMN "skipped" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "migration_inbound_skip_has_no_variant" CHECK (NOT "skipped" OR "variantId" IS NULL);

ALTER TYPE "entitlement"."MigrationSkipReason" ADD VALUE 'inbound_skipped';
